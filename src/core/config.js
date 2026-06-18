const os = require("os");
const path = require("path");

function readConfig() {
  const argv = process.argv.slice(2);
  const mode = argv[0] || "";
  const stateDir = process.env.DAWN_STATE_DIR || path.join(os.homedir(), ".exclusive-dawn");

  return {
    mode,
    argv,
    stateDir,
    workspaceId: readTextEnv("DAWN_WORKSPACE_ID") || "default",
    workspaceRoot: readTextEnv("DAWN_WORKSPACE_ROOT") || process.cwd(),
    userName: readTextEnv("DAWN_USER_NAME") || "User",
    userGender: readTextEnv("DAWN_USER_GENDER") || "female",
    allowedUserIds: readListEnv("DAWN_ALLOWED_USER_IDS"),
    channel: readTextEnv("DAWN_CHANNEL") || "weixin",
    runtime: readTextEnv("DAWN_RUNTIME") || "codex",
    runtimeFallbackEnabled: readBoolEnv("DAWN_RUNTIME_FALLBACK_ENABLED"),
    timelineCommand: readTextEnv("DAWN_TIMELINE_COMMAND") || "timeline-for-agent",
    accountId: readTextEnv("DAWN_ACCOUNT_ID"),
    weixinBaseUrl: readTextEnv("DAWN_WEIXIN_BASE_URL") || "https://ilinkai.weixin.qq.com",
    weixinCdnBaseUrl: readTextEnv("DAWN_WEIXIN_CDN_BASE_URL") || "https://novac2c.cdn.weixin.qq.com/c2c",
    weixinConfigFile: path.join(stateDir, "weixin-config.json"),
    weixinMinChunkChars: readIntEnv("DAWN_WEIXIN_MIN_CHUNK_CHARS"),
    weixinLogChunks: readBoolEnv("DAWN_WEIXIN_LOG_CHUNKS"),
    weixinQrBotType: readTextEnv("DAWN_WEIXIN_QR_BOT_TYPE") || "3",
    accountsDir: path.join(stateDir, "accounts"),
    reminderQueueFile: path.join(stateDir, "reminder-queue.json"),
    systemMessageQueueFile: path.join(stateDir, "system-message-queue.json"),
    deferredSystemReplyQueueFile: path.join(stateDir, "deferred-system-replies.json"),
    checkinConfigFile: path.join(stateDir, "checkin-config.json"),
    timelineScreenshotQueueFile: path.join(stateDir, "timeline-screenshot-queue.json"),
    projectToolContextFile: path.join(stateDir, "project-tool-runtime-context.json"),
    weixinInstructionsFile: path.join(stateDir, "weixin-instructions.md"),
    weixinOperationsFile: path.resolve(__dirname, "..", "..", "templates", "weixin-operations.md"),
    stickersDir: path.join(stateDir, "stickers"),
    stickerAssetsDir: path.join(stateDir, "stickers", "assets"),
    stickersIndexFile: path.join(stateDir, "stickers", "index.json"),
    stickerTagsFile: path.join(stateDir, "stickers", "tags.json"),
    stickersTemplateDir: path.resolve(__dirname, "..", "..", "templates", "stickers"),
    stickersTemplateIndexFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "tags.json"),
    stickerNormalizeGifScript: path.resolve(__dirname, "..", "..", "scripts", "normalize-sticker-gif.js"),
    diaryDir: path.join(stateDir, "diary"),
    locationStoreFile: path.join(stateDir, "locations.json"),
    locationHost: readTextEnv("DAWN_LOCATION_HOST") || "0.0.0.0",
    locationPort: readIntEnv("DAWN_LOCATION_PORT") || 4318,
    locationToken: readTextEnv("DAWN_LOCATION_TOKEN"),
    locationHistoryLimit: readIntEnv("DAWN_LOCATION_HISTORY_LIMIT") || 1000,
    locationMovementEventLimit: readIntEnv("DAWN_LOCATION_MOVEMENT_EVENT_LIMIT"),
    locationBatteryHistoryLimit: readIntEnv("DAWN_LOCATION_BATTERY_HISTORY_LIMIT"),
    locationKnownPlaces: readKnownPlacesEnv(),
    locationKnownPlaceRadiusMeters: readIntEnv("DAWN_LOCATION_PLACE_RADIUS_METERS") || 150,
    locationStayMergeRadiusMeters: readIntEnv("DAWN_LOCATION_STAY_MERGE_RADIUS_METERS") || 100,
    locationStayBreakConfirmRadiusMeters: readIntEnv("DAWN_LOCATION_STAY_BREAK_RADIUS_METERS") || 200,
    locationStayBreakConfirmSamples: readIntEnv("DAWN_LOCATION_STAY_BREAK_SAMPLES") || 2,
    locationMajorMoveThresholdMeters: readIntEnv("DAWN_LOCATION_MAJOR_MOVE_THRESHOLD_METERS") || 1000,
    startWithLocationServer: resolveLocationServerEnabled({
      mode,
      enabled: readOptionalBoolEnv("DAWN_ENABLE_LOCATION_SERVER"),
    }),
    syncBufferDir: path.join(stateDir, "sync-buffers"),
    codexEndpoint: readTextEnv("DAWN_CODEX_ENDPOINT"),
    codexCommand: readTextEnv("DAWN_CODEX_COMMAND"),
    codexModel: readTextEnv("DAWN_CODEX_MODEL"),
    codexModelProvider: readTextEnv("DAWN_CODEX_MODEL_PROVIDER"),
    codexNativeImageInput: readOptionalBoolEnv("DAWN_CODEX_NATIVE_IMAGE_INPUT"),
    geminiApiKey: readTextEnv("DAWN_GEMINI_API_KEY"),
    geminiModel: readTextEnv("DAWN_GEMINI_MODEL"),
    geminiApiBaseUrl: readTextEnv("DAWN_GEMINI_API_BASE_URL"),
    jinaApiKey: readTextEnv("DAWN_JINA_API_KEY"),
    visionMode: readTextEnv("DAWN_VISION_MODE") || "auto",
    visionProvider: readTextEnv("DAWN_VISION_PROVIDER") || "openai-compatible",
    visionApiBaseUrl: readTextEnv("DAWN_VISION_API_BASE_URL"),
    visionApiKey: readTextEnv("DAWN_VISION_API_KEY"),
    visionModel: readTextEnv("DAWN_VISION_MODEL"),
    visionTimeoutMs: readIntEnv("DAWN_VISION_TIMEOUT_MS") || 30_000,
    notionApiKey: readTextEnv("DAWN_NOTION_API_KEY") || readTextEnv("NOTION_API_KEY"),
    notionAssignmentsDatabaseId: readTextEnv("DAWN_NOTION_ASSIGNMENTS_DATABASE_ID"),
    notionSubjectsDatabaseId: readTextEnv("DAWN_NOTION_SUBJECTS_DATABASE_ID"),
    notionTimeDatabaseId: readTextEnv("DAWN_NOTION_TIME_DATABASE_ID"),
    notionDailyRecordDatabaseId: readTextEnv("DAWN_NOTION_DAILY_RECORD_DATABASE_ID"),
    claudeCommand: readTextEnv("DAWN_CLAUDE_COMMAND") || "claude",
    claudeModel: readTextEnv("DAWN_CLAUDE_MODEL") || "",
    claudeContextWindow: readIntEnv("DAWN_CLAUDE_CONTEXT_WINDOW"),
    claudeMaxOutputTokens: readIntEnv("CLAUDE_CODE_MAX_OUTPUT_TOKENS"),
    claudePermissionMode: readTextEnv("DAWN_CLAUDE_PERMISSION_MODE") || "default",
    claudeDisableVerbose: readBoolEnv("DAWN_CLAUDE_DISABLE_VERBOSE"),
    claudeExtraArgs: readListEnv("DAWN_CLAUDE_EXTRA_ARGS"),
    sessionsFile: path.join(stateDir, "sessions.json"),
    sharedHistoryFile: path.join(stateDir, "shared-history.json"),
    startWithCheckin: (mode === "start" && hasArgFlag(argv, "--checkin")) || readBoolEnv("DAWN_ENABLE_CHECKIN"),
  };
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readOptionalBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  return undefined;
}

function readIntEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readKnownPlacesEnv() {
  const fromJson = parseKnownPlacesJson(readTextEnv("DAWN_LOCATION_KNOWN_PLACES"));
  const fromCenters = [
    parseKnownPlaceCenter("home", readTextEnv("DAWN_LOCATION_HOME_CENTER")),
    parseKnownPlaceCenter("work", readTextEnv("DAWN_LOCATION_WORK_CENTER")),
  ].filter(Boolean);
  return [...fromJson, ...fromCenters];
}

function parseKnownPlacesJson(value) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseKnownPlaceCenter(tag, value) {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return { tag, latitude, longitude };
}

function hasArgFlag(argv, flag) {
  return Array.isArray(argv) && argv.some((item) => String(item || "").trim() === flag);
}

function resolveLocationServerEnabled({ mode, enabled }) {
  if (mode !== "start") {
    return false;
  }
  if (typeof enabled === "boolean") {
    return enabled;
  }
  return false;
}

module.exports = { readConfig };
