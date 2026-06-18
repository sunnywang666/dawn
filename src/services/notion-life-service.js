const NOTION_API_BASE_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const VALID_TIME_TAGS = [
  "宿舍", "整理", "收尾", "技能", "学习", "阅读", "运动",
  "游戏", "娱乐", "家人", "朋友", "竞赛", "学术", "求职", "规划", "情绪", "睡觉",
];

const VALID_MOODS = ["很好", "好", "一般", "差", "很差"];

class NotionLifeService {
  constructor({ config }) {
    this.config = config || {};
  }

  isConfigured() {
    return Boolean(
      normalizeText(this.config.notionApiKey) &&
      normalizeText(this.config.notionTimeDatabaseId)
    );
  }

  ensureConfigured() {
    if (!this.isConfigured()) {
      throw new Error("Notion life service not configured. Set DAWN_NOTION_API_KEY and DAWN_NOTION_TIME_DATABASE_ID.");
    }
  }

  async startTimeEntry({ task, tags, date } = {}) {
    this.ensureConfigured();
    const now = nowIso();
    const taskName = normalizeText(task) || "专注";

    const dailyRecordId = await this.ensureDailyRecordId(date);
    const dbId = normalizeDatabaseId(this.config.notionTimeDatabaseId);

    const properties = {
      Task: { title: [{ text: { content: taskName } }] },
      "Start time": { date: { start: now } },
    };

    const validTags = normalizeList(tags).filter((t) => VALID_TIME_TAGS.includes(t));
    if (validTags.length) {
      properties.Tags = { multi_select: validTags.map((name) => ({ name })) };
    }

    if (dailyRecordId) {
      properties["每日日记"] = { relation: [{ id: dailyRecordId }] };
    }

    const created = await this.requestJson({
      path: "/pages",
      method: "POST",
      body: { parent: { database_id: dbId }, properties },
      label: "notion start time entry",
    });

    return {
      id: normalizeText(created.id),
      url: normalizeText(created.url),
      task: taskName,
      startedAt: now,
    };
  }

  async stopTimeEntry({ entryId } = {}) {
    this.ensureConfigured();
    const now = nowIso();
    let pageId = normalizePageId(entryId);

    if (!pageId) {
      const open = await this.findOpenTimeEntry();
      if (!open) {
        return { stopped: false, message: "没有正在进行的计时条目" };
      }
      pageId = normalizePageId(open.id);
      const props = open.properties || {};
      const taskName = readTitle(props.Task);
      const startedAt = readDate(props["Start time"]);
      const updated = await this.requestJson({
        path: `/pages/${encodeURIComponent(pageId)}`,
        method: "PATCH",
        body: { properties: { "End time": { date: { start: now } } } },
        label: "notion stop time entry",
      });
      return {
        stopped: true,
        id: normalizeText(updated.id),
        url: normalizeText(updated.url),
        task: taskName,
        startedAt,
        endedAt: now,
      };
    }

    const updated = await this.requestJson({
      path: `/pages/${encodeURIComponent(pageId)}`,
      method: "PATCH",
      body: { properties: { "End time": { date: { start: now } } } },
      label: "notion stop time entry",
    });

    return {
      stopped: true,
      id: normalizeText(updated.id),
      url: normalizeText(updated.url),
      endedAt: now,
    };
  }

  async findOpenTimeEntry() {
    const dbId = normalizeDatabaseId(this.config.notionTimeDatabaseId);
    const response = await this.requestJson({
      path: `/databases/${encodeURIComponent(dbId)}/query`,
      method: "POST",
      body: {
        page_size: 5,
        filter: {
          and: [
            { property: "Start time", date: { is_not_empty: true } },
            { property: "End time", date: { is_empty: true } },
          ],
        },
        sorts: [{ property: "Start time", direction: "descending" }],
      },
      label: "notion find open time entry",
    });
    return response.results?.[0] || null;
  }

  async ensureDailyRecordId(dateStr) {
    const databaseId = normalizeText(this.config.notionDailyRecordDatabaseId);
    if (!databaseId) return "";
    const date = normalizeText(dateStr) || todayIso();
    const existing = await this.findDailyRecord(date);
    if (existing) return normalizePageId(existing.id);
    const created = await this.createDailyRecord(date);
    return normalizePageId(created.id);
  }

  async findDailyRecord(date) {
    const dbId = normalizeDatabaseId(this.config.notionDailyRecordDatabaseId);
    const response = await this.requestJson({
      path: `/databases/${encodeURIComponent(dbId)}/query`,
      method: "POST",
      body: {
        page_size: 1,
        filter: { property: "记录日期", date: { equals: date } },
      },
      label: "notion find daily record",
    });
    return response.results?.[0] || null;
  }

  async createDailyRecord(date) {
    const dbId = normalizeDatabaseId(this.config.notionDailyRecordDatabaseId);
    const [, month, day] = date.split("-");
    const title = `${month}/${day}`;
    return await this.requestJson({
      path: "/pages",
      method: "POST",
      body: {
        parent: { database_id: dbId },
        properties: {
          日期: { title: [{ text: { content: title } }] },
          记录日期: { date: { start: date } },
        },
      },
      label: "notion create daily record",
    });
  }

  async writeDailyRecord(fields = {}) {
    const databaseId = normalizeText(this.config.notionDailyRecordDatabaseId);
    if (!databaseId) {
      throw new Error("Notion daily record database not configured. Set DAWN_NOTION_DAILY_RECORD_DATABASE_ID.");
    }
    const date = normalizeText(fields.date) || todayIso();
    const existing = await this.findDailyRecord(date);
    let pageId;
    if (existing) {
      pageId = normalizePageId(existing.id);
    } else {
      const created = await this.createDailyRecord(date);
      pageId = normalizePageId(created.id);
    }

    const properties = buildDailyRecordProperties(fields);

    const updated = await this.requestJson({
      path: `/pages/${encodeURIComponent(pageId)}`,
      method: "PATCH",
      body: { properties },
      label: "notion write daily record",
    });

    return {
      id: normalizeText(updated.id),
      url: normalizeText(updated.url),
      date,
      fieldsWritten: Object.keys(properties),
    };
  }

  async requestJson({ path, method = "GET", body = null, label = "notion request" }) {
    const response = await fetch(`${NOTION_API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${normalizeText(this.config.notionApiKey)}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await response.text();
    const parsed = raw ? parseJson(raw, label) : {};
    if (!response.ok) {
      const message = normalizeText(parsed?.message) || raw.slice(0, 300);
      throw new Error(`${label} failed: ${response.status} ${response.statusText} ${message}`);
    }
    return parsed;
  }
}

function buildDailyRecordProperties(fields) {
  const props = {};
  if (fields.bedtime) props["睡觉时间"] = { date: { start: fields.bedtime } };
  if (fields.wakeTime) props["起床时间"] = { date: { start: fields.wakeTime } };
  if (isFiniteNumber(fields.sleepHours)) props["睡眠时长(h)"] = { number: fields.sleepHours };
  if (isFiniteNumber(fields.sleepScore)) props["睡眠评分"] = { number: fields.sleepScore };
  if (isFiniteNumber(fields.deepSleepMin)) props["深睡(min)"] = { number: fields.deepSleepMin };
  if (isFiniteNumber(fields.lightSleepMin)) props["浅睡(min)"] = { number: fields.lightSleepMin };
  if (isFiniteNumber(fields.remSleepMin)) props["REM(min)"] = { number: fields.remSleepMin };
  if (isFiniteNumber(fields.steps)) props["步数"] = { number: fields.steps };
  if (isFiniteNumber(fields.calories)) props["热量(kcal)"] = { number: fields.calories };
  if (typeof fields.exercised === "boolean") props["是否运动"] = { checkbox: fields.exercised };
  if (isFiniteNumber(fields.exerciseMin)) props["运动时长(min)"] = { number: fields.exerciseMin };
  if (Array.isArray(fields.exerciseTypes) && fields.exerciseTypes.length) {
    props["运动类型"] = { multi_select: fields.exerciseTypes.map((name) => ({ name })) };
  }
  if (isFiniteNumber(fields.vigorousMin)) props["中高强度(min)"] = { number: fields.vigorousMin };
  if (isFiniteNumber(fields.restingHeartRate)) props["静息心率(bpm)"] = { number: fields.restingHeartRate };
  if (isFiniteNumber(fields.stressScore)) props["压力评分"] = { number: fields.stressScore };
  const mood = normalizeText(fields.mood);
  if (VALID_MOODS.includes(mood)) props["情绪"] = { select: { name: mood } };
  if (normalizeText(fields.dietSummary)) props["饮食摘要"] = { rich_text: [{ text: { content: truncateText(fields.dietSummary) } }] };
  if (normalizeText(fields.completedItems)) props["完成事项"] = { rich_text: [{ text: { content: truncateText(fields.completedItems) } }] };
  if (normalizeText(fields.notes)) props["备注"] = { rich_text: [{ text: { content: truncateText(fields.notes) } }] };
  return props;
}

function nowIso() {
  return new Date().toISOString();
}

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean);
  const s = normalizeText(value);
  return s ? [s] : [];
}

function normalizePageId(value) {
  return normalizeText(value).replace(/-/g, "");
}

function normalizeDatabaseId(value) {
  return normalizeText(value).replace(/^collection:\/\//, "").replace(/-/g, "");
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function truncateText(value, max = 1900) {
  const s = normalizeText(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function readTitle(property) {
  return Array.isArray(property?.title)
    ? property.title.map((item) => item?.plain_text || item?.text?.content || "").join("").trim()
    : "";
}

function readDate(property) {
  return normalizeText(property?.date?.start);
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

module.exports = { NotionLifeService, VALID_TIME_TAGS };
