const https = require("https");
const http = require("http");
const { URL } = require("url");

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const DEFAULT_MODEL = "models/gemini-2.5-flash";
// Fallback used after all primary retries fail with 503/429
const FALLBACK_MODEL = "models/gemini-2.5-flash-lite";

class GeminiApiClient {
  constructor({ apiKey, baseUrl, model }) {
    this.apiKey = apiKey || "";
    this.baseUrl = (typeof baseUrl === "string" && baseUrl.trim()) ? baseUrl.trim() : DEFAULT_BASE_URL;
    this.model = (typeof model === "string" && model.trim()) ? model.trim() : DEFAULT_MODEL;
    this.listeners = new Set();
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _emit(event) {
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
  }

  async sendMessage({ threadId, turnId, messages, tools = [], onToolCall = null }) {
    this._emit({ type: "turn.started", sessionId: threadId, turnId });

    const MAX_TOOL_STEPS = 8;
    let currentMessages = messages;
    let finalText = "";
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    try {
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      const result = await this._doRequestWithRetry({ messages: currentMessages, tools });
      totalPromptTokens += result.promptTokens;
      totalCompletionTokens += result.completionTokens;

      // No tool calls — we have the final reply
      if (!result.toolCalls.length || !onToolCall) {
        finalText = result.text;
        break;
      }

      // Assistant message with tool_calls
      currentMessages = [
        ...currentMessages,
        {
          role: "assistant",
          content: result.text || null,
          tool_calls: result.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
      ];

      // Execute each tool call, collect results
      for (const tc of result.toolCalls) {
        let content;
        try {
          content = await onToolCall(tc.name, tc.arguments);
        } catch (err) {
          content = JSON.stringify({ error: err.message });
        }
        currentMessages = [...currentMessages, { role: "tool", tool_call_id: tc.id, content }];
      }
    }

    } catch (error) {
      this._emit({ type: "turn.failed", sessionId: threadId, turnId, error: error.message });
      throw error;
    }

    if (totalPromptTokens || totalCompletionTokens) {
      this._emit({
        type: "context.updated",
        sessionId: threadId,
        usage: { input_tokens: totalPromptTokens, output_tokens: totalCompletionTokens },
      });
    }

    this._emit({ type: "reply.completed", sessionId: threadId, turnId, itemId: `item-${turnId}`, text: finalText });
    this._emit({ type: "turn.completed", sessionId: threadId, turnId, text: finalText });
    return { text: finalText, promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
  }

  async _doRequestWithRetry({ messages, tools = [] }) {
    const RETRY_DELAYS_MS = [3000, 8000, 20000];
    let lastError = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await this._doRequest({ messages, tools });
      } catch (error) {
        lastError = error;
        const is503 = error.message.includes("503") || error.message.includes("UNAVAILABLE");
        const is429 = error.message.includes("429") || error.message.includes("RESOURCE_EXHAUSTED");
        if ((is503 || is429) && attempt < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[attempt];
          console.log(`[gemini-runtime] ${error.message.slice(0, 80)} — retry in ${delay / 1000}s (attempt ${attempt + 1})`);
          await new Promise((res) => setTimeout(res, delay));
          continue;
        }
        break;
      }
    }
    // Fallback model
    const is503 = lastError.message.includes("503") || lastError.message.includes("UNAVAILABLE");
    const is429 = lastError.message.includes("429") || lastError.message.includes("RESOURCE_EXHAUSTED");
    if ((is503 || is429) && this.model !== FALLBACK_MODEL) {
      console.log(`[gemini-runtime] primary ${this.model} still unavailable — trying fallback ${FALLBACK_MODEL}`);
      try {
        return await this._doRequest({ messages, tools, modelOverride: FALLBACK_MODEL });
      } catch (fallbackError) {
        lastError = fallbackError;
      }
    }
    throw lastError;
  }

  _doRequest({ messages, modelOverride, tools = [] }) {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : this.baseUrl + "/";
    const endpointUrl = new URL("chat/completions", base);
    const requestBody = {
      model: modelOverride || this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length) {
      requestBody.tools = tools;
      requestBody.tool_choice = "auto";
    }
    const body = JSON.stringify(requestBody);

    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const lib = endpointUrl.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
      const req = lib.request(endpointUrl.toString(), options, (res) => {
        if (res.statusCode >= 400) {
          let errBody = "";
          res.on("data", (c) => { errBody += c.toString(); });
          res.on("end", () => {
            let detail = errBody.trim().slice(0, 300);
            try {
              const parsed = JSON.parse(errBody);
              detail = parsed?.error?.message || detail;
            } catch {}
            reject(new Error(`Gemini API HTTP ${res.statusCode}: ${detail}`));
          });
          res.on("error", reject);
          return;
        }

        let fullText = "";
        let promptTokens = 0;
        let completionTokens = 0;
        let buf = "";
        // tool_calls accumulated by index across SSE chunks
        const toolCallsByIndex = {};

        res.on("data", (chunk) => {
          buf += chunk.toString();
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed?.choices?.[0]?.delta;
              if (typeof delta?.content === "string") fullText += delta.content;
              if (Array.isArray(delta?.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallsByIndex[idx]) {
                    toolCallsByIndex[idx] = { id: "", name: "", arguments: "" };
                  }
                  if (tc.id) toolCallsByIndex[idx].id = tc.id;
                  if (tc.function?.name) toolCallsByIndex[idx].name += tc.function.name;
                  if (tc.function?.arguments) toolCallsByIndex[idx].arguments += tc.function.arguments;
                }
              }
              if (parsed?.usage) {
                promptTokens = parsed.usage.prompt_tokens || 0;
                completionTokens = parsed.usage.completion_tokens || 0;
              }
            } catch {}
          }
        });

        const toolCalls = () => Object.values(toolCallsByIndex).filter((tc) => tc.name);
        res.on("end", () => resolve({ text: stripThinkingTags(fullText), toolCalls: toolCalls(), promptTokens, completionTokens }));
        res.on("error", reject);
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}

// Strip Gemini 2.5 thinking blocks that occasionally appear inline in content
function stripThinkingTags(text) {
  if (!text) return text;
  // Remove <thinking>...</thinking> and <think>...</think> blocks (including multiline)
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

module.exports = { GeminiApiClient };
