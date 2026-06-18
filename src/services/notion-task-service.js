const NOTION_API_BASE_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const DEFAULT_ASSIGNMENTS_PAGE_SIZE = 10;
const MAX_ASSIGNMENTS_PAGE_SIZE = 25;

class NotionTaskService {
  constructor({ config }) {
    this.config = config || {};
  }

  isConfigured() {
    return Boolean(normalizeText(this.config.notionApiKey) && normalizeText(this.config.notionAssignmentsDatabaseId));
  }

  async listAssignments({ status = "open", limit = DEFAULT_ASSIGNMENTS_PAGE_SIZE, query = "" } = {}) {
    this.ensureConfigured();
    const pageSize = normalizeLimit(limit);
    const filter = buildAssignmentFilter({ status, query });
    const body = {
      page_size: pageSize,
      sorts: [
        { property: "Due Date", direction: "ascending" },
        { property: "Priority", direction: "ascending" },
      ],
    };
    if (filter) {
      body.filter = filter;
    }
    const response = await this.requestJson({
      path: `/databases/${encodeURIComponent(normalizeDatabaseId(this.config.notionAssignmentsDatabaseId))}/query`,
      method: "POST",
      body,
      label: "notion list assignments",
    });
    return {
      assignments: (response.results || []).map(normalizeAssignmentPage),
      hasMore: Boolean(response.has_more),
      nextCursor: normalizeText(response.next_cursor),
    };
  }

  async createAssignment(args = {}) {
    this.ensureConfigured();
    const title = normalizeText(args.title);
    if (!title) {
      throw new Error("dawn_notion_assignment_create input.title is required.");
    }
    const subject = normalizeText(args.subject);
    const subjectPageId = normalizeText(args.subjectPageId) || await this.findSubjectPageId(subject);
    const properties = {
      "Assignment Name": {
        title: [{ text: { content: title } }],
      },
      Status: {
        status: { name: normalizeStatus(args.status) },
      },
      Type: {
        select: { name: normalizeType(args.type) },
      },
      Priority: {
        select: { name: normalizePriority(args.priority) },
      },
    };

    const dueDate = normalizeText(args.dueDate);
    if (dueDate) {
      properties["Due Date"] = { date: { start: dueDate } };
    }
    const estimatedHours = normalizeNumber(args.estimatedHours);
    if (estimatedHours !== null) {
      properties["Estimated Time（h）"] = { number: estimatedHours };
    }
    const requirement = buildRequirementText({
      requirement: args.requirement,
      uncertain: args.uncertain,
      sourceSummary: args.sourceSummary,
      subject,
    });
    if (requirement) {
      properties.Requirement = { rich_text: [{ text: { content: truncateRichText(requirement) } }] };
    }
    if (subjectPageId) {
      properties.Subject = { relation: [{ id: normalizePageId(subjectPageId) }] };
    }

    const created = await this.requestJson({
      path: "/pages",
      method: "POST",
      body: {
        parent: { database_id: normalizeDatabaseId(this.config.notionAssignmentsDatabaseId) },
        properties,
        children: buildPageChildren({
          sourceSummary: args.sourceSummary,
          sourceText: args.sourceText,
          sourceFilePaths: args.sourceFilePaths,
          uncertain: args.uncertain,
        }),
      },
      label: "notion create assignment",
    });

    return normalizeAssignmentPage(created);
  }

  async findSubjectPageId(subject) {
    const databaseId = normalizeText(this.config.notionSubjectsDatabaseId);
    const query = normalizeText(subject);
    if (!databaseId || !query) {
      return "";
    }
    const response = await this.requestJson({
      path: `/databases/${encodeURIComponent(normalizeDatabaseId(databaseId))}/query`,
      method: "POST",
      body: {
        page_size: 5,
        filter: {
          property: "Name",
          title: { contains: query },
        },
      },
      label: "notion find subject",
    });
    return normalizeText(response?.results?.[0]?.id);
  }

  ensureConfigured() {
    if (!this.isConfigured()) {
      throw new Error("Notion task sync is not configured. Set DAWN_NOTION_API_KEY and DAWN_NOTION_ASSIGNMENTS_DATABASE_ID.");
    }
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

function buildAssignmentFilter({ status, query }) {
  const filters = [];
  const normalizedStatus = normalizeText(status).toLowerCase();
  if (!normalizedStatus || normalizedStatus === "open") {
    filters.push({ property: "Status", status: { does_not_equal: "Completed" } });
    filters.push({ property: "Status", status: { does_not_equal: "Skip" } });
  } else if (normalizedStatus !== "all") {
    filters.push({ property: "Status", status: { equals: normalizeStatus(status) } });
  }
  const normalizedQuery = normalizeText(query);
  if (normalizedQuery) {
    filters.push({ property: "Assignment Name", title: { contains: normalizedQuery } });
  }
  if (!filters.length) {
    return null;
  }
  return filters.length === 1 ? filters[0] : { and: filters };
}

function buildRequirementText({ requirement, uncertain, sourceSummary, subject }) {
  const parts = [];
  const normalizedRequirement = normalizeText(requirement);
  if (normalizedRequirement) {
    parts.push(normalizedRequirement);
  }
  const normalizedSubject = normalizeText(subject);
  if (normalizedSubject) {
    parts.push(`课程/来源：${normalizedSubject}`);
  }
  const normalizedSourceSummary = normalizeText(sourceSummary);
  if (normalizedSourceSummary) {
    parts.push(`来源摘要：${normalizedSourceSummary}`);
  }
  const normalizedUncertain = normalizeList(uncertain);
  if (normalizedUncertain.length) {
    parts.push(`待确认：${normalizedUncertain.join("；")}`);
  }
  return parts.join("\n");
}

function buildPageChildren({ sourceSummary, sourceText, sourceFilePaths, uncertain }) {
  const children = [];
  const summary = normalizeText(sourceSummary);
  if (summary) {
    children.push(paragraphBlock(`来源摘要：${summary}`));
  }
  const files = normalizeList(sourceFilePaths);
  if (files.length) {
    children.push(paragraphBlock(`来源文件：${files.join("；")}`));
  }
  const uncertainItems = normalizeList(uncertain);
  if (uncertainItems.length) {
    children.push(paragraphBlock(`待确认：${uncertainItems.join("；")}`));
  }
  const text = normalizeText(sourceText);
  if (text) {
    children.push(paragraphBlock(`原始信息：${truncateRichText(text, 1800)}`));
  }
  return children;
}

function paragraphBlock(content) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: truncateRichText(content) } }],
    },
  };
}

function normalizeAssignmentPage(page = {}) {
  const properties = page.properties || {};
  return {
    id: normalizeText(page.id),
    url: normalizeText(page.url),
    title: readTitle(properties["Assignment Name"]),
    type: readSelect(properties.Type),
    status: readStatus(properties.Status),
    priority: readSelect(properties.Priority),
    dueDate: readDate(properties["Due Date"]),
    estimatedHours: readNumber(properties["Estimated Time（h）"]),
    requirement: readRichText(properties.Requirement),
    subjectIds: readRelationIds(properties.Subject),
  };
}

function readTitle(property) {
  return Array.isArray(property?.title)
    ? property.title.map((item) => item?.plain_text || item?.text?.content || "").join("").trim()
    : "";
}

function readRichText(property) {
  return Array.isArray(property?.rich_text)
    ? property.rich_text.map((item) => item?.plain_text || item?.text?.content || "").join("").trim()
    : "";
}

function readSelect(property) {
  return normalizeText(property?.select?.name);
}

function readStatus(property) {
  return normalizeText(property?.status?.name);
}

function readDate(property) {
  return normalizeText(property?.date?.start);
}

function readNumber(property) {
  return typeof property?.number === "number" ? property.number : null;
}

function readRelationIds(property) {
  return Array.isArray(property?.relation)
    ? property.relation.map((item) => normalizeText(item?.id)).filter(Boolean)
    : [];
}

function normalizeStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "learning") return "Learning";
  if (normalized === "in progress" || normalized === "in_progress" || normalized === "doing") return "In Progress";
  if (normalized === "completed" || normalized === "complete" || normalized === "done") return "Completed";
  if (normalized === "skip" || normalized === "skipped") return "Skip";
  return "Todo";
}

function normalizeType(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "exam" || normalized === "考试") {
    return "Exam";
  }
  return "Assignment";
}

function normalizePriority(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "high" || normalized === "高") return "High";
  if (normalized === "low" || normalized === "低") return "Low";
  return "Medium";
}

function normalizeNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    return DEFAULT_ASSIGNMENTS_PAGE_SIZE;
  }
  return Math.max(1, Math.min(MAX_ASSIGNMENTS_PAGE_SIZE, parsed));
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean);
  }
  const normalized = normalizeText(value);
  return normalized ? [normalized] : [];
}

function normalizePageId(value) {
  return normalizeText(value).replace(/-/g, "");
}

function normalizeDatabaseId(value) {
  return normalizeText(value).replace(/^collection:\/\//, "").replace(/-/g, "");
}

function truncateRichText(value, maxLength = 1900) {
  const text = normalizeText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { NotionTaskService };
