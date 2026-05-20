const JINA_SEARCH_BASE = "https://s.jina.ai/";
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_RESULT_CHARS = 3_000;

class SearchService {
  async search({ query = "" } = {}) {
    const q = String(query).trim();
    if (!q) {
      throw new Error("search query cannot be empty");
    }
    const url = JINA_SEARCH_BASE + encodeURIComponent(q);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Accept: "text/plain" },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Jina search HTTP ${res.status}`);
      }
      const text = await res.text();
      const trimmed = text.trim();
      return trimmed.length > MAX_RESULT_CHARS
        ? trimmed.slice(0, MAX_RESULT_CHARS) + "\n…（结果已截断）"
        : trimmed;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { SearchService };
