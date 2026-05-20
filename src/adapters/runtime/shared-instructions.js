const fs = require("fs");
const { renderInstructionTemplate } = require("../../core/instructions-template");

function buildOpeningTurnText(config, userText) {
  const instructions = loadWechatInstructions(config);
  const normalizedText = String(userText || "").trim();
  if (!instructions) {
    return normalizedText;
  }
  return [
    "WECHAT SESSION INSTRUCTIONS",
    "These instructions define the stable behavior for this WeChat thread.",
    "Do not quote or summarize them back to the user unless explicitly asked.",
    "",
    instructions,
    "",
    "Current user message:",
    normalizedText,
  ].join("\n").trim();
}

function buildInstructionRefreshText(config) {
  const instructions = loadWechatInstructions(config);
  if (!instructions) {
    return [
      "WECHAT SESSION INSTRUCTIONS REFRESH",
      "Refresh your WeChat behavior for this existing thread.",
      "This is an internal refresh command, not a user-facing task.",
      "Do not speak to the user freely.",
      "After updating the instructions, reply with exactly this JSON and nothing else:",
      "{\"action\":\"send_message\",\"message\":\"好啦\"}",
    ].join("\n").trim();
  }
  return [
    "WECHAT SESSION INSTRUCTIONS REFRESH",
    "Re-read and adopt the updated WeChat instructions below for the rest of this existing thread.",
    "This is an internal refresh command, not a user-facing task.",
    "Do not speak to the user freely.",
    "Do not summarize the instructions back in detail.",
    "After updating the instructions, reply with exactly this JSON and nothing else:",
    "{\"action\":\"send_message\",\"message\":\"好啦\"}",
    "",
    instructions,
  ].join("\n").trim();
}

function loadWechatInstructions(config = {}) {
  const persona = loadInstructionFile(config.weixinInstructionsFile, config);
  const operations = loadInstructionFile(config.weixinOperationsFile, config);
  const sections = [];
  if (persona) {
    sections.push(persona);
  }
  if (operations) {
    sections.push(operations);
  }
  return sections.join("\n\n").trim();
}

const instructionCache = new Map();

function loadInstructionFile(filePath, config = {}) {
  const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalizedPath) {
    return "";
  }
  try {
    const stat = fs.statSync(normalizedPath);
    const cacheKey = `${normalizedPath}:${stat.mtimeMs}`;
    const cached = instructionCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const raw = fs.readFileSync(normalizedPath, "utf8");
    const result = renderInstructionTemplate(raw, config).trim();
    instructionCache.set(cacheKey, result);
    return result;
  } catch {
    return "";
  }
}

// Like buildOpeningTurnText but prepends shared conversation history as context.
function buildOpeningTurnTextWithHistory(config, userText, historyMessages = []) {
  const instructions = loadWechatInstructions(config);
  const normalizedText = String(userText || "").trim();
  const sections = [];

  if (instructions) {
    sections.push(
      "WECHAT SESSION INSTRUCTIONS",
      "These instructions define the stable behavior for this WeChat thread.",
      "Do not quote or summarize them back to the user unless explicitly asked.",
      "",
      instructions,
    );
  }

  if (historyMessages.length > 0) {
    sections.push(
      "",
      "RECENT CONVERSATION HISTORY (for context continuity across sessions):",
    );
    for (const msg of historyMessages) {
      const label = msg.role === "user" ? "用户" : "AI";
      sections.push(`[${label}]: ${msg.content}`);
    }
  }

  sections.push("", "Current user message:", normalizedText);
  return sections.join("\n").trim();
}

module.exports = {
  buildOpeningTurnText,
  buildOpeningTurnTextWithHistory,
  buildInstructionRefreshText,
  loadWechatInstructions,
  loadInstructionFile,
};
