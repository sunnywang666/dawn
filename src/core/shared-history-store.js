const fs = require("fs");
const path = require("path");

const MAX_MESSAGES = 60; // 30 exchanges per binding

class SharedHistoryStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = {};
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        this.state = parsed;
      }
    } catch {
      this.state = {};
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.state), "utf8");
    } catch {}
  }

  _key(bindingKey, workspaceRoot) {
    return `${bindingKey || ""}::${workspaceRoot || ""}`;
  }

  getMessages(bindingKey, workspaceRoot, limit = MAX_MESSAGES) {
    this.load();
    const messages = this.state[this._key(bindingKey, workspaceRoot)] || [];
    return messages.slice(-limit).map(({ role, content }) => ({ role, content }));
  }

  appendPair(bindingKey, workspaceRoot, userText, assistantText) {
    if (!userText && !assistantText) return;
    this.load();
    const key = this._key(bindingKey, workspaceRoot);
    if (!this.state[key]) this.state[key] = [];
    const entries = this.state[key];
    if (userText) entries.push({ role: "user", content: String(userText) });
    if (assistantText) entries.push({ role: "assistant", content: String(assistantText) });
    if (entries.length > MAX_MESSAGES) {
      this.state[key] = entries.slice(-MAX_MESSAGES);
    }
    this.save();
  }

  clearMessages(bindingKey, workspaceRoot) {
    const key = this._key(bindingKey, workspaceRoot);
    delete this.state[key];
    this.save();
  }
}

module.exports = { SharedHistoryStore };
