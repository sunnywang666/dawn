const { createCodexRuntimeAdapter } = require("../adapters/runtime/codex");
const { createClaudeCodeRuntimeAdapter } = require("../adapters/runtime/claudecode");

const DEFAULT_BLOCK_MS = 30 * 60 * 1000; // 30 minutes
const MAX_BLOCK_MS = 4 * 60 * 60 * 1000; // 4 hours cap for exponential backoff
const MAX_BUFFER_PAIRS = 4;
const PREAMBLE_TEXT_CAP = 1500;

// Patterns that strongly suggest the runtime is rate-limited or out of quota.
// Pulled from real-world Codex / Claude / OpenAI error wording.
const QUOTA_PATTERNS = [
  /rate.?limit/i,
  /\bquota\b/i,
  /usage[^.]{0,40}(exceed|limit|cap)/i,
  /you.{0,5}have.{0,5}reached/i,
  /you.?ve.{0,8}(used|reached|hit)/i,
  /you.{0,5}have.{0,5}used/i,
  /\b429\b/,
  /too many requests/i,
  /insufficient.{0,5}(credit|quota|balance)/i,
  /credit.{0,5}(exhaust|deplete|low)/i,
  /message[\s_-]?(limit|cap)/i,
  /messages?.{0,10}(remain|left)/i,
  /(weekly|daily|monthly|hourly|plan).{0,5}(limit|cap|quota)/i,
  /reach(ed)?\s+(your|the)\s+(weekly|daily|monthly|hourly|plan|message|usage)/i,
  /out\s+of\s+(messages|tokens|credits|quota)/i,
  /resets?\s+(at|in)\s+\d/i,
  /try.{0,8}again.{0,8}(later|in\s+\d)/i,
  /no\s+(more\s+)?(messages|credits|tokens)\s+(left|remaining|available)/i,
  /(over|exceed(ed)?)\s+(your|the|allotted)/i,
  /额度/u, // 额度
  /限额/u, // 限额
  /配额/u, // 配额
  /超出.{0,8}额度/u, // 超出...额度
  /请求过于频繁/u, // 请求过于频繁
  /消息.{0,8}用尽/u, // 消息...用尽
  /(已|将于).{0,12}重置/u, // 已用尽/将于HH:mm重置
  /剩余.{0,8}消息/u, // 剩余...消息
  /you.?ve\s+hit\s+(your\s+)?limit/i,
  /resets?\s+\d{1,2}:\d{2}\s*(am|pm)/i,
  /runtime\s+process\s+exited\s+unexpectedly/i,
];

const RETRY_AFTER_PATTERNS = [
  /retry[-_\s]?after[:\s]+(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hrs?|hours?)?/i,
  /reset[s]?[^\d]{0,15}(\d{1,2}:\d{2})/i,
  /resets?[^\d]{0,8}in\s+(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hrs?|hours?)?/i,
  /try.{0,10}again.{0,8}in\s+(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hrs?|hours?)?/i,
  /额度将于\s*(\d{1,2}:\d{2})/u, // 额度将于HH:mm重置
];

function isQuotaError(text) {
  if (typeof text !== "string" || !text) {
    return false;
  }
  return QUOTA_PATTERNS.some((pattern) => pattern.test(text));
}

function parseRetryAfterMs(text) {
  if (typeof text !== "string" || !text) {
    return null;
  }
  for (const pattern of RETRY_AFTER_PATTERNS) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }
    const [, capture, unitRaw] = match;
    if (!capture) {
      continue;
    }
    if (capture.includes(":")) {
      const [hours, minutes] = capture.split(":").map((part) => Number(part));
      if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
        continue;
      }
      const now = new Date();
      const reset = new Date(now);
      reset.setHours(hours, minutes, 0, 0);
      if (reset.getTime() <= now.getTime()) {
        reset.setDate(reset.getDate() + 1);
      }
      return Math.max(1000, reset.getTime() - now.getTime());
    }
    const num = Number(capture);
    if (!Number.isFinite(num)) {
      continue;
    }
    const unit = typeof unitRaw === "string" ? unitRaw.toLowerCase() : "";
    if (unit.startsWith("h")) {
      return num * 60 * 60 * 1000;
    }
    if (unit.startsWith("min") || unit === "m") {
      return num * 60 * 1000;
    }
    return num * 1000;
  }
  return null;
}

function truncate(text, max) {
  const value = typeof text === "string" ? text : String(text || "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function buildPreamble({ recent, fromKey, toKey, userName = "user", currentUserText = "" }) {
  if (!Array.isArray(recent) || !recent.length) {
    return "";
  }
  let items = recent.slice();
  // Drop the trailing entry if it is the same user message we are about to
  // re-send — otherwise the preamble echoes the current turn.
  const last = items[items.length - 1];
  const trimmedCurrent = typeof currentUserText === "string" ? currentUserText.trim() : "";
  if (last && last.role === "user" && trimmedCurrent && last.text.trim() === trimmedCurrent) {
    items = items.slice(0, -1);
  }
  if (!items.length) {
    return "";
  }
  const lines = [
    `[系统提示] 上一轮在 ${fromKey} 中进行，因额度原因临时切换到 ${toKey}。请保持人设、语气和上下文连续。`,
    "最近的对话片段：",
    "",
  ];
  for (const item of items) {
    if (!item || !item.text) {
      continue;
    }
    const role = item.role === "assistant" ? "你" : userName;
    lines.push(`[${role}] ${truncate(item.text, 400)}`);
  }
  lines.push("", "[用户本轮消息]");
  const text = lines.join("\n");
  return truncate(text, PREAMBLE_TEXT_CAP);
}

function buildSwitchNotice({ fromKey, toKey, reason }) {
  const why = reason ? `（${reason}）` : "";
  return `[exclusive-dawn] 运行时从 ${fromKey} 切换到 ${toKey}${why}。成息会尽量连续，但内部会话会重建。`;
}

function buildBothBlockedNotice({ codexUntil, claudeUntil }) {
  const fmt = (ts) => {
    if (!ts || !Number.isFinite(ts)) {
      return "未知";
    }
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  };
  return [
    "[exclusive-dawn] 两个运行时都被限额了，本轮消息未能回复。",
    `codex 预计可用：${fmt(codexUntil)}`,
    `claudecode 预计可用：${fmt(claudeUntil)}`,
    "请稍后重发，或打开其中一个运行时的计划。",
  ].join("\n");
}

function createRuntimeRouter(config, hooks = {}) {
  const preferredKey = config.runtime === "claudecode" ? "claudecode" : "codex";
  const adapters = {
    codex: createCodexRuntimeAdapter(config),
    claudecode: createClaudeCodeRuntimeAdapter(config),
  };
  let activeKey = preferredKey;

  const quotaState = {
    codex: { blockedUntil: 0, lastErrorText: "", consecutiveBlocks: 0 },
    claudecode: { blockedUntil: 0, lastErrorText: "", consecutiveBlocks: 0 },
  };

  const conversationBuffers = new Map(); // bindingKey -> [{role, text, at}]
  const pendingPreambleByBinding = new Map(); // bindingKey -> { fromKey, toKey }
  const lastPreparedByBinding = new Map(); // bindingKey -> { workspaceRoot, prepared }
  const threadOwner = new Map(); // threadId -> runtimeKey, for routing events

  // Soft-detection of "completed but empty" turns. A runtime that silently
  // returns nothing on multiple consecutive turns is almost certainly out of
  // quota (the explicit `turn/failed` path may not fire on all providers).
  // Tracked per runtime; reset whenever any text is produced.
  const emptyTurnState = {
    codex: { activeTurnId: null, hadText: false, consecutiveEmpty: 0 },
    claudecode: { activeTurnId: null, hadText: false, consecutiveEmpty: 0 },
  };
  const EMPTY_TURN_THRESHOLD = 2;

  let appListener = null;

  const userLabel = config.userName || "user";

  function recordExchange(bindingKey, role, text) {
    if (!bindingKey || !text) {
      return;
    }
    if (!conversationBuffers.has(bindingKey)) {
      conversationBuffers.set(bindingKey, []);
    }
    const buf = conversationBuffers.get(bindingKey);
    const normalized = truncate(String(text), 800);
    // Dedupe consecutive identical entries — protects against replay paths
    // that re-send the same user text on a fallback runtime.
    const last = buf[buf.length - 1];
    if (last && last.role === role && last.text === normalized) {
      return;
    }
    buf.push({ role, text: normalized, at: Date.now() });
    const max = MAX_BUFFER_PAIRS * 2 + 2;
    while (buf.length > max) {
      buf.shift();
    }
  }

  function getRecent(bindingKey, n = MAX_BUFFER_PAIRS * 2) {
    const buf = conversationBuffers.get(bindingKey) || [];
    return buf.slice(-n);
  }

  function isBlocked(key) {
    return Date.now() < (quotaState[key]?.blockedUntil || 0);
  }

  function clearBlock(key) {
    if (!quotaState[key]) {
      return;
    }
    if (quotaState[key].blockedUntil) {
      console.log(`[router-runtime] ${key} unblocked (success observed)`);
    }
    quotaState[key].blockedUntil = 0;
    quotaState[key].lastErrorText = "";
    quotaState[key].consecutiveBlocks = 0;
  }

  function setBlock(key, retryMs, errorText) {
    if (!quotaState[key]) {
      return;
    }
    quotaState[key].consecutiveBlocks += 1;
    const backoffMultiplier = Math.pow(2, quotaState[key].consecutiveBlocks - 1);
    const baseMs = Number.isFinite(retryMs) && retryMs > 0 ? retryMs : DEFAULT_BLOCK_MS;
    const ms = Math.min(baseMs * backoffMultiplier, MAX_BLOCK_MS);
    quotaState[key].blockedUntil = Date.now() + ms;
    quotaState[key].lastErrorText = truncate(errorText || "", 500);
    console.log(`[router-runtime] ${key} blocked for ${Math.round(ms / 60000)}min (attempt=${quotaState[key].consecutiveBlocks}): ${truncate(errorText || "", 200)}`);
  }

  function emitSwitchNotice({ fromKey, toKey, reason, bindingKey = "" }) {
    if (typeof hooks.onSwitchNotice !== "function") {
      return;
    }
    try {
      hooks.onSwitchNotice({
        text: buildSwitchNotice({ fromKey, toKey, reason }),
        bindingKey,
        fromKey,
        toKey,
        reason,
      });
    } catch (error) {
      console.warn(`[router-runtime] onSwitchNotice handler threw: ${error.message}`);
    }
  }

  function switchActiveTo(nextKey, reason, bindingKey = "") {
    if (nextKey === activeKey) {
      return false;
    }
    const prev = activeKey;
    activeKey = nextKey;
    console.log(`[router-runtime] active ${prev} -> ${nextKey}${reason ? ` (${reason})` : ""}`);
    emitSwitchNotice({ fromKey: prev, toKey: nextKey, reason, bindingKey });
    return true;
  }

  function notifyBothBlocked(bindingKey = "") {
    if (typeof hooks.onBothBlockedNotice !== "function") {
      return;
    }
    try {
      hooks.onBothBlockedNotice({
        text: buildBothBlockedNotice({
          codexUntil: quotaState.codex.blockedUntil,
          claudeUntil: quotaState.claudecode.blockedUntil,
        }),
        bindingKey,
      });
    } catch (error) {
      console.warn(`[router-runtime] onBothBlockedNotice handler threw: ${error.message}`);
    }
  }

  function findBindingByThreadId(threadId, key) {
    if (!threadId) {
      return null;
    }
    const owningKey = threadOwner.get(threadId) || key;
    const store = adapters[owningKey]?.getSessionStore?.();
    if (!store?.findBindingForThreadId) {
      return null;
    }
    const linked = store.findBindingForThreadId(threadId);
    return linked?.bindingKey || null;
  }

  function maybeReplay(bindingKey, fromKey, toKey, reason) {
    const replay = lastPreparedByBinding.get(bindingKey);
    if (!replay || typeof hooks.replayPrepared !== "function") {
      return;
    }
    pendingPreambleByBinding.set(bindingKey, { fromKey, toKey });
    setImmediate(() => {
      Promise.resolve()
        .then(() => hooks.replayPrepared({
          bindingKey,
          workspaceRoot: replay.workspaceRoot,
          prepared: replay.prepared,
          fromKey,
          toKey,
          reason,
        }))
        .catch((error) => {
          console.error(`[router-runtime] replay failed bindingKey=${bindingKey}: ${error.message}`);
        });
    });
  }

  function handleQuotaTurnFailed(key, event) {
    const text = event?.payload?.text || "";
    // Always log the raw failure text so users can capture the exact wording
    // that comes back from a runtime — that's what lets us tighten the quota
    // pattern table later.
    const preview = truncate(text.replace(/\s+/g, " "), 600);
    const matched = isQuotaError(text);
    console.log(
      `[router-runtime] ${key} turn.failed quotaMatch=${matched} threadId=${event?.payload?.threadId || ""} text="${preview}"`
    );
    if (!matched) {
      return false;
    }
    const retryMs = parseRetryAfterMs(text);
    setBlock(key, retryMs, text);
    const threadId = event.payload?.threadId;
    const bindingKey = findBindingByThreadId(threadId, key);
    const otherKey = key === "codex" ? "claudecode" : "codex";
    if (isBlocked(otherKey)) {
      notifyBothBlocked(bindingKey);
      // Tag the event so app-side handlers know the router already messaged the user.
      if (event && event.payload) {
        event.payload.routerHandled = "both-blocked";
      }
      return true;
    }
    switchActiveTo(otherKey, `${key} quota-exhausted`, bindingKey);
    if (bindingKey) {
      maybeReplay(bindingKey, key, otherKey, "quota-exhausted");
      if (event && event.payload) {
        event.payload.routerHandled = "switched";
      }
    }
    return true;
  }

  function handleSuccessEvent(key, event) {
    // IMPORTANT: only treat reply.completed-with-text as a real success.
    //
    // A bare `runtime.turn.completed` fires for empty turns too (model
    // produced no assistant message). If we cleared the block on any
    // turn.completed, the soft-detection that just blocked the runtime
    // would be undone by the *same* empty turn, and we'd flip back and
    // forth forever. Only "actual text was emitted" counts.
    const type = event?.type;
    const text = typeof event?.payload?.text === "string" ? event.payload.text : "";
    const hasText = text.trim().length > 0;
    const isRealReply = type === "runtime.reply.completed" && hasText;

    if (isRealReply) {
      if (key === preferredKey && isBlocked(key)) {
        clearBlock(key);
      } else if (key === preferredKey && activeKey !== preferredKey) {
        switchActiveTo(preferredKey, "preferred runtime succeeded");
      }
    }

    const threadId = event?.payload?.threadId;
    if (threadId && hasText) {
      const bindingKey = findBindingByThreadId(threadId, key);
      if (bindingKey) {
        recordExchange(bindingKey, "assistant", text);
      }
    }
  }

  function trackEmptyTurn(key, event) {
    const state = emptyTurnState[key];
    if (!state) {
      return;
    }
    const type = event?.type;
    const turnId = event?.payload?.turnId || null;
    const text = typeof event?.payload?.text === "string" ? event.payload.text : "";

    if (type === "runtime.turn.started") {
      state.activeTurnId = turnId;
      state.hadText = false;
      return;
    }
    if (type === "runtime.reply.delta" || type === "runtime.reply.completed") {
      if (text && text.trim()) {
        state.hadText = true;
      }
      return;
    }
    if (type === "runtime.turn.completed") {
      if (!state.activeTurnId || state.activeTurnId !== turnId) {
        // We never saw turn.started — reset and bail (still in setup or after
        // crash). Don't count this as empty since we lack the baseline.
        state.activeTurnId = null;
        state.hadText = false;
        return;
      }
      const wasEmpty = !state.hadText;
      if (wasEmpty) {
        state.consecutiveEmpty += 1;
        console.warn(
          `[router-runtime] ${key} produced empty turn (consecutive=${state.consecutiveEmpty} threshold=${EMPTY_TURN_THRESHOLD} threadId=${event?.payload?.threadId || ""})`
        );
        if (state.consecutiveEmpty >= EMPTY_TURN_THRESHOLD && key === preferredKey) {
          const otherKey = key === "codex" ? "claudecode" : "codex";
          if (!isBlocked(otherKey)) {
            const reasonText = `(soft) ${state.consecutiveEmpty} consecutive empty turns on ${key}`;
            setBlock(key, DEFAULT_BLOCK_MS, reasonText);
            const threadId = event?.payload?.threadId;
            const bindingKey = findBindingByThreadId(threadId, key);
            switchActiveTo(otherKey, `${key} empty-turn soft-detection`, bindingKey);
            if (bindingKey) {
              maybeReplay(bindingKey, key, otherKey, "empty-turn-soft");
            }
            state.consecutiveEmpty = 0;
          } else {
            console.warn(`[router-runtime] both runtimes appear blocked; cannot soft-switch from ${key}`);
          }
        }
      } else {
        state.consecutiveEmpty = 0;
      }
      state.activeTurnId = null;
      state.hadText = false;
    }
    if (type === "runtime.turn.failed") {
      // A failed turn resets the empty counter too — explicit failure path
      // is handled separately by handleQuotaTurnFailed.
      state.activeTurnId = null;
      state.hadText = false;
    }
  }

  function setupAdapterListener(key) {
    const adapter = adapters[key];
    adapter.onEvent((event, raw) => {
      if (event?.payload?.threadId) {
        threadOwner.set(event.payload.threadId, key);
      }
      trackEmptyTurn(key, event);
      if (event?.type === "runtime.turn.failed") {
        handleQuotaTurnFailed(key, event);
      } else if (event?.type === "runtime.reply.completed" || event?.type === "runtime.turn.completed") {
        handleSuccessEvent(key, event);
      }
      if (typeof appListener === "function") {
        try {
          appListener(event, raw);
        } catch (error) {
          console.error(`[router-runtime] downstream listener threw: ${error.message}`);
        }
      }
    });
  }

  // Wire up both adapters before returning.
  setupAdapterListener("codex");
  setupAdapterListener("claudecode");

  // Choose runtime for the next outbound turn.
  function pickRuntimeForTurn() {
    if (!isBlocked(preferredKey)) {
      return { key: preferredKey, bothBlocked: false };
    }
    const otherKey = preferredKey === "codex" ? "claudecode" : "codex";
    if (!isBlocked(otherKey)) {
      return { key: otherKey, bothBlocked: false };
    }
    return { key: preferredKey, bothBlocked: true };
  }

  function findBindingForThreadIdAcrossStores(threadId) {
    if (!threadId) {
      return null;
    }
    const owningKey = threadOwner.get(threadId);
    const tryKeys = [];
    if (owningKey && adapters[owningKey]) {
      tryKeys.push(owningKey);
    }
    for (const k of Object.keys(adapters)) {
      if (!tryKeys.includes(k)) {
        tryKeys.push(k);
      }
    }
    for (const key of tryKeys) {
      const store = adapters[key].getSessionStore();
      const fn = store?.findBindingForThreadId;
      if (typeof fn !== "function") {
        continue;
      }
      // Each adapter's SessionStore was constructed with its own runtimeId, so
      // calling the method without explicit args searches that runtime's threads.
      const result = fn.call(store, threadId);
      if (result) {
        return result;
      }
    }
    return null;
  }

  const sessionStoreProxy = new Proxy({}, {
    get(_target, prop) {
      if (prop === "findBindingForThreadId") {
        return findBindingForThreadIdAcrossStores;
      }
      const store = adapters[activeKey].getSessionStore();
      const value = store?.[prop];
      if (typeof value === "function") {
        return value.bind(store);
      }
      return value;
    },
  });

  async function applyPreambleAndSend(args, runtimeKey) {
    const bindingKey = args?.bindingKey || "";
    let outgoingText = typeof args?.text === "string" ? args.text : String(args?.text || "");
    const pendingPreamble = pendingPreambleByBinding.get(bindingKey);
    if (pendingPreamble) {
      const preamble = buildPreamble({
        recent: getRecent(bindingKey),
        fromKey: pendingPreamble.fromKey,
        toKey: pendingPreamble.toKey,
        userName: userLabel,
        currentUserText: args?.text,
      });
      if (preamble) {
        outgoingText = `${preamble}\n${outgoingText}`;
      }
      pendingPreambleByBinding.delete(bindingKey);
    }
    if (bindingKey && args?.text) {
      recordExchange(bindingKey, "user", args.text);
    }
    const augmented = { ...args, text: outgoingText };
    const result = await adapters[runtimeKey].sendTurn(augmented);
    if (result?.threadId) {
      threadOwner.set(result.threadId, runtimeKey);
    }
    return result;
  }

  return {
    isRouter: true,
    describe() {
      const inner = adapters[activeKey].describe();
      return {
        ...inner,
        id: activeKey,
        routerId: "router",
        innerId: inner.id,
        activeRuntime: activeKey,
        preferredRuntime: preferredKey,
        quota: {
          codex: { blockedUntil: quotaState.codex.blockedUntil },
          claudecode: { blockedUntil: quotaState.claudecode.blockedUntil },
        },
      };
    },
    createClient() {
      return adapters[activeKey].createClient
        ? adapters[activeKey].createClient()
        : null;
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
    getTurnCapabilities(args) {
      const adapter = adapters[activeKey];
      if (typeof adapter.getTurnCapabilities === "function") {
        return adapter.getTurnCapabilities(args);
      }
      return { nativeImageInput: false, toolImageRead: false };
    },
    async initialize() {
      const results = {};
      let activeReady = null;
      const initOrder = [preferredKey, preferredKey === "codex" ? "claudecode" : "codex"];
      for (const key of initOrder) {
        try {
          results[key] = await adapters[key].initialize();
          if (key === activeKey) {
            activeReady = results[key];
          }
        } catch (error) {
          console.warn(`[router-runtime] ${key} initialize failed: ${error.message}`);
          results[key] = { error: error.message };
          if (key === preferredKey) {
            // Preferred failed to init — mark as blocked so we don't keep trying it.
            setBlock(key, DEFAULT_BLOCK_MS, `initialize failed: ${error.message}`);
            const otherKey = key === "codex" ? "claudecode" : "codex";
            if (!isBlocked(otherKey)) {
              switchActiveTo(otherKey, `${key} init failed`);
            }
          }
        }
      }
      activeReady = activeReady || results[activeKey] || { endpoint: "(unknown)", models: [] };
      return {
        ...activeReady,
        routerActive: activeKey,
        routerPreferred: preferredKey,
        routerResults: results,
      };
    },
    async close() {
      for (const key of Object.keys(adapters)) {
        try {
          await adapters[key].close();
        } catch (error) {
          console.warn(`[router-runtime] ${key} close failed: ${error.message}`);
        }
      }
    },
    async startFreshThreadDraft(args) {
      return adapters[activeKey].startFreshThreadDraft(args);
    },
    async respondApproval(args) {
      return adapters[activeKey].respondApproval(args);
    },
    async cancelTurn(args) {
      return adapters[activeKey].cancelTurn(args);
    },
    async resumeThread(args) {
      return adapters[activeKey].resumeThread(args);
    },
    async compactThread(args) {
      return adapters[activeKey].compactThread(args);
    },
    async refreshThreadInstructions(args) {
      return adapters[activeKey].refreshThreadInstructions(args);
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn(args) {
      const choice = pickRuntimeForTurn();
      if (choice.bothBlocked) {
        notifyBothBlocked(args?.bindingKey || "");
        const error = new Error("both runtimes are rate-limited");
        error.code = "ROUTER_BOTH_BLOCKED";
        throw error;
      }
      if (choice.key !== activeKey) {
        const fromKey = activeKey;
        switchActiveTo(choice.key, isBlocked(preferredKey) ? "preferred blocked" : "preferred available", args?.bindingKey || "");
        // When the runtime changes for routing reasons, set a preamble so the
        // new runtime gets enough continuity to keep persona/topic.
        if (args?.bindingKey) {
          pendingPreambleByBinding.set(args.bindingKey, { fromKey, toKey: choice.key });
        }
      }
      try {
        return await applyPreambleAndSend(args, choice.key);
      } catch (error) {
        const message = error?.message || String(error || "");
        if (isQuotaError(message)) {
          const retryMs = parseRetryAfterMs(message);
          setBlock(choice.key, retryMs, message);
          const otherKey = choice.key === "codex" ? "claudecode" : "codex";
          if (!isBlocked(otherKey)) {
            switchActiveTo(otherKey, `${choice.key} quota-exhausted (sync)`, args?.bindingKey || "");
            if (args?.bindingKey) {
              pendingPreambleByBinding.set(args.bindingKey, { fromKey: choice.key, toKey: otherKey });
            }
            return applyPreambleAndSend(args, otherKey);
          }
          notifyBothBlocked(args?.bindingKey || "");
        }
        throw error;
      }
    },
    rememberPrepared({ bindingKey, workspaceRoot, prepared }) {
      if (!bindingKey || !prepared) {
        return;
      }
      lastPreparedByBinding.set(bindingKey, { workspaceRoot, prepared });
    },
    forgetPrepared(bindingKey) {
      if (bindingKey) {
        lastPreparedByBinding.delete(bindingKey);
      }
    },
    recordAssistantText(bindingKey, text) {
      recordExchange(bindingKey, "assistant", text);
    },
    getQuotaState() {
      return {
        codex: { blockedUntil: quotaState.codex.blockedUntil, lastErrorText: quotaState.codex.lastErrorText, consecutiveBlocks: quotaState.codex.consecutiveBlocks },
        claudecode: { blockedUntil: quotaState.claudecode.blockedUntil, lastErrorText: quotaState.claudecode.lastErrorText, consecutiveBlocks: quotaState.claudecode.consecutiveBlocks },
        active: activeKey,
        preferred: preferredKey,
      };
    },
    forceSwitch(targetKey) {
      const validKeys = ["codex", "claudecode"];
      if (!validKeys.includes(targetKey)) {
        return { switched: false, reason: `unknown runtime "${targetKey}"` };
      }
      if (targetKey === activeKey) {
        return { switched: false, reason: `already active: ${targetKey}` };
      }
      clearBlock(targetKey);
      switchActiveTo(targetKey, "manual /use command");
      return { switched: true, active: activeKey };
    },
  };
}

module.exports = {
  createRuntimeRouter,
  isQuotaError,
  parseRetryAfterMs,
  QUOTA_PATTERNS,
  RETRY_AFTER_PATTERNS,
};
