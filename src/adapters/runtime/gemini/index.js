const fs = require("fs");
const { randomUUID } = require("crypto");
const { SessionStore } = require("../codex/session-store");
const { loadWechatInstructions } = require("../shared-instructions");
const { GeminiApiClient } = require("./api-client");

function createGeminiRuntimeAdapter(config, { toolHost = null } = {}) {
  const apiKey = config.geminiApiKey || "";
  const model = config.geminiModel || "models/gemini-2.5-flash";
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "gemini" });
  const sharedHistory = config.sharedHistoryStore;
  const apiClient = new GeminiApiClient({
    apiKey,
    baseUrl: config.geminiApiBaseUrl || "",
    model,
  });

  let globalListener = null;

  apiClient.onMessage((event) => {
    const mapped = mapGeminiEventToRuntimeEvent(event);
    if (mapped && globalListener) {
      globalListener(mapped, event);
    }
  });

  return {
    describe() {
      return {
        id: "gemini",
        kind: "runtime",
        model,
        sessionsFile: config.sessionsFile,
      };
    },
    onEvent(listener) {
      if (typeof listener !== "function") return () => {};
      globalListener = listener;
      return () => { if (globalListener === listener) globalListener = null; };
    },
    getSessionStore() { return sessionStore; },
    getTurnCapabilities() {
      return { nativeImageInput: true, toolImageRead: false };
    },
    async initialize() {
      if (!apiKey) {
        console.warn("[gemini-runtime] CYBERBOSS_GEMINI_API_KEY is not set");
      }
      return { model, models: [] };
    },
    async close() {},
    async startFreshThreadDraft({ workspaceRoot }) {
      for (const binding of sessionStore.listBindings()) {
        if (binding.activeWorkspaceRoot === workspaceRoot) {
          sharedHistory?.clearMessages(binding.bindingKey, workspaceRoot);
          sessionStore.clearThreadIdForWorkspace(binding.bindingKey, workspaceRoot);
        }
      }
      return { workspaceRoot };
    },
    async respondApproval({ requestId, decision }) {
      return { requestId, decision };
    },
    async cancelTurn({ threadId, turnId }) {
      return { threadId, turnId };
    },
    async resumeThread({ threadId }) {
      return { threadId };
    },
    async compactThread({ threadId, workspaceRoot, bindingKey }) {
      // Keep only the last 10 exchanges in shared history
      if (sharedHistory && bindingKey && workspaceRoot) {
        const msgs = sharedHistory.getMessages(bindingKey, workspaceRoot);
        if (msgs.length > 20) {
          sharedHistory.clearMessages(bindingKey, workspaceRoot);
          // Re-add last 20 messages
          for (let i = 0; i < msgs.length - 20; i += 2) {
            const u = msgs[i]; const a = msgs[i + 1];
            if (u && a) sharedHistory.appendPair(bindingKey, workspaceRoot, u.content, a.content);
          }
        }
      }
      return { threadId };
    },
    async refreshThreadInstructions({ threadId }) {
      // Instructions are a system message injected on every call — no explicit refresh needed.
      return { threadId };
    },
    async sendTextTurn(args) { return this.sendTurn(args); },
    async sendTurn({ bindingKey, workspaceRoot, text, attachments = [], metadata = {} }) {
      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      if (!threadId) {
        threadId = randomUUID();
        sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
      }
      const turnId = `turn-${randomUUID()}`;

      // Build messages: system persona + shared history + current user message (with optional images)
      const instructions = loadWechatInstructions(config);
      const geminiAddendum = '默认用"我"指代自己，不要主动用第三人称自称自己的名字（例如避免说"晨曦觉得""晨曦在这里"）；如果白昼明确要求某种特定的说话方式或角色扮演，可以配合调整。工具调用完成后，直接用中文自然地回复白昼，不要向她描述你调用了什么工具或做了什么操作。';
      const localTime = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date()).replace(/\//g, "-");
      const timeNote = `当前时间：${localTime}`;
      const systemContent = [instructions, geminiAddendum, timeNote].filter(Boolean).join("\n\n");
      const systemMessages = systemContent ? [{ role: "system", content: systemContent }] : [];
      const history = sharedHistory ? sharedHistory.getMessages(bindingKey, workspaceRoot) : [];
      const userContent = await buildUserContent(text, attachments);
      const messages = [...systemMessages, ...history, { role: "user", content: userContent }];

      const tools = toolHost ? buildGeminiTools(toolHost.listTools()) : [];
      const toolContext = {
        runtimeId: "gemini",
        workspaceRoot,
        bindingKey,
        threadId,
        accountId: String(metadata?.accountId || ""),
        senderId: String(metadata?.senderId || ""),
      };
      const onToolCall = toolHost ? async (toolName, argsJson) => {
        try {
          const args = parseToolArgs(argsJson);
          const output = await toolHost.invokeTool(toolName, args, toolContext);
          const data = output?.data !== undefined ? output.data : output;
          return JSON.stringify(data ?? {});
        } catch (err) {
          console.warn(`[gemini-runtime] tool ${toolName} failed: ${err.message}`);
          return JSON.stringify({ error: err.message });
        }
      } : null;

      apiClient.sendMessage({ threadId, turnId, messages, tools, onToolCall })
        .catch((error) => {
          if (globalListener) {
            globalListener({
              type: "runtime.turn.failed",
              payload: { threadId, turnId, text: `❌ Gemini: ${error.message}` },
            }, null);
          }
        });

      return { threadId, turnId };
    },
  };
}

function mapGeminiEventToRuntimeEvent(event) {
  switch (event?.type) {
    case "turn.started":
      return {
        type: "runtime.turn.started",
        payload: { threadId: event.sessionId, turnId: event.turnId },
      };
    case "reply.completed":
      return {
        type: "runtime.reply.completed",
        payload: {
          threadId: event.sessionId,
          turnId: event.turnId,
          itemId: event.itemId,
          text: event.text,
        },
      };
    case "turn.completed":
      return {
        type: "runtime.turn.completed",
        payload: { threadId: event.sessionId, turnId: event.turnId, text: event.text },
      };
    case "turn.failed":
      return {
        type: "runtime.turn.failed",
        payload: {
          threadId: event.sessionId,
          turnId: event.turnId,
          text: event.error || "❌ Gemini request failed",
        },
      };
    case "context.updated":
      return {
        type: "runtime.context.updated",
        payload: {
          runtimeId: "gemini",
          threadId: event.sessionId,
          inputTokens: event.usage?.input_tokens || 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: event.usage?.output_tokens || 0,
          currentTokens: (event.usage?.input_tokens || 0) + (event.usage?.output_tokens || 0),
        },
      };
    default:
      return null;
  }
}

// Convert ProjectToolHost tool list to OpenAI function-calling format.
function buildGeminiTools(toolList) {
  return (Array.isArray(toolList) ? toolList : []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: String(tool.description || ""),
      parameters: tool.inputSchema || { type: "object", properties: {} },
    },
  }));
}

function parseToolArgs(argsJson) {
  try {
    return JSON.parse(argsJson);
  } catch {
    return {};
  }
}

// Build the user message content — plain string when no images, array when images present.
async function buildUserContent(text, attachments) {
  const images = (Array.isArray(attachments) ? attachments : []).filter(
    (a) => a?.absolutePath && (a.isImage || String(a.contentType || "").startsWith("image/")),
  );
  if (!images.length) return text;

  const parts = [{ type: "text", text: text || "" }];
  for (const img of images) {
    try {
      const bytes = fs.readFileSync(img.absolutePath);
      const contentType = img.contentType || "image/jpeg";
      parts.push({
        type: "image_url",
        image_url: { url: `data:${contentType};base64,${bytes.toString("base64")}` },
      });
    } catch {
      // skip unreadable image, still send text
    }
  }
  return parts.length > 1 ? parts : text;
}

module.exports = { createGeminiRuntimeAdapter };
