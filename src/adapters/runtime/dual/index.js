const { createCodexRuntimeAdapter } = require("../codex");
const { createGeminiRuntimeAdapter } = require("../gemini");

// Messages matching these patterns are routed to Codex (tool-capable).
// Everything else goes to Gemini (chat/persona).
const TOOL_INTENT_PATTERNS = [
  /notion/iu,
  /待办|任务|作业|题目|论文|考试/iu,
  /截止|ddl|due\s*date/iu,
  /提醒|remind/iu,
  /日程|安排|计划|schedule/iu,
  /帮我.{0,12}(加|创建|新建|记录|写进|写到|存)/iu,
  /sticker|表情包/iu,
  /发.*文件|发.*图片/iu,
];

function classifyIntent(text) {
  if (!text || typeof text !== "string") {
    return "chat";
  }
  return TOOL_INTENT_PATTERNS.some((p) => p.test(text)) ? "tool" : "chat";
}

function createDualRuntimeAdapter(config) {
  const gemini = createGeminiRuntimeAdapter(config);
  const codex = createCodexRuntimeAdapter(config);
  const adapters = { gemini, codex };

  const threadOwner = new Map(); // threadId → "gemini" | "codex"
  let appListener = null;

  function setupListener(adapter, key) {
    adapter.onEvent((event, raw) => {
      const threadId = event?.payload?.threadId;
      if (threadId) {
        threadOwner.set(threadId, key);
      }
      if (typeof appListener === "function") {
        try {
          appListener(event, raw);
        } catch {}
      }
    });
  }

  setupListener(gemini, "gemini");
  setupListener(codex, "codex");

  function findBindingForThreadId(threadId) {
    if (!threadId) {
      return null;
    }
    const ownerKey = threadOwner.get(threadId);
    const tryOrder = ownerKey
      ? [ownerKey, ...Object.keys(adapters).filter((k) => k !== ownerKey)]
      : Object.keys(adapters);
    for (const key of tryOrder) {
      const store = adapters[key].getSessionStore();
      if (typeof store?.findBindingForThreadId === "function") {
        const result = store.findBindingForThreadId(threadId);
        if (result) {
          return result;
        }
      }
    }
    return null;
  }

  // Proxy session store: findBindingForThreadId searches both adapters;
  // everything else delegates to gemini's store (primary for most ops).
  const sessionStoreProxy = new Proxy({}, {
    get(_target, prop) {
      if (prop === "findBindingForThreadId") {
        return findBindingForThreadId;
      }
      const store = gemini.getSessionStore();
      const val = store?.[prop];
      return typeof val === "function" ? val.bind(store) : val;
    },
  });

  return {
    describe() {
      return { id: "dual", kind: "runtime" };
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      appListener = listener;
      return () => {
        if (appListener === listener) {
          appListener = null;
        }
      };
    },
    getSessionStore() {
      return sessionStoreProxy;
    },
    getTurnCapabilities() {
      // Gemini handles images natively; Codex uses tool-based reads.
      return { nativeImageInput: true, toolImageRead: true };
    },
    async initialize() {
      const [geminiResult, codexResult] = await Promise.allSettled([
        gemini.initialize(),
        codex.initialize(),
      ]);
      if (geminiResult.status === "rejected") {
        console.warn("[dual] gemini initialize failed:", geminiResult.reason?.message);
      }
      if (codexResult.status === "rejected") {
        console.warn("[dual] codex initialize failed:", codexResult.reason?.message);
      }
      return {
        id: "dual",
        gemini: geminiResult.status === "fulfilled" ? geminiResult.value : { error: geminiResult.reason?.message },
        codex: codexResult.status === "fulfilled" ? codexResult.value : { error: codexResult.reason?.message },
      };
    },
    async close() {
      await Promise.allSettled([gemini.close(), codex.close()]);
    },
    async startFreshThreadDraft(args) {
      await Promise.allSettled([
        gemini.startFreshThreadDraft(args),
        codex.startFreshThreadDraft(args),
      ]);
      return { workspaceRoot: args?.workspaceRoot };
    },
    async respondApproval(args) {
      return codex.respondApproval(args);
    },
    async cancelTurn(args) {
      return codex.cancelTurn(args);
    },
    async resumeThread(args) {
      return codex.resumeThread(args);
    },
    async compactThread(args) {
      return gemini.compactThread(args);
    },
    async refreshThreadInstructions(args) {
      return codex.refreshThreadInstructions(args);
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn(args) {
      const text = typeof args?.text === "string" ? args.text : "";
      const intent = classifyIntent(text);
      if (intent === "tool") {
        console.log("[dual] → codex (tool intent)");
        return codex.sendTurn(args);
      }
      console.log("[dual] → gemini (chat intent)");
      return gemini.sendTurn(args);
    },
  };
}

module.exports = { createDualRuntimeAdapter, classifyIntent };
