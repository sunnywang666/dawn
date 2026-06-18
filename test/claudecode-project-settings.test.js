const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ensureClaudeProjectMcpConfig,
  buildClaudeProjectMcpServerConfig,
} = require("../src/adapters/runtime/claudecode/project-settings");

test("ensureClaudeProjectMcpConfig upserts Dawn MCP server into workspace .mcp.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-claude-settings-"));
  const workspaceRoot = path.join(root, "workspace");
  const appHome = path.join(root, "dawn-home");
  const configPath = path.join(workspaceRoot, ".mcp.json");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(appHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(appHome, "bin", "exclusive-dawn.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      other: {
        command: "uvx",
        args: ["other"],
      },
    },
  }, null, 2));

  const result = ensureClaudeProjectMcpConfig({ workspaceRoot, appHome });
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(result.configPath, configPath);
  assert.deepEqual(saved.mcpServers.other, {
    command: "uvx",
    args: ["other"],
  });
  assert.deepEqual(saved.mcpServers.dawn_tools, buildClaudeProjectMcpServerConfig({
    workspaceRoot,
    appHome,
  }));
});

test("ensureClaudeProjectMcpConfig rewrites stale Dawn MCP server config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-claude-settings-stale-"));
  const workspaceRoot = path.join(root, "workspace");
  const appHome = path.join(root, "dawn-home");
  const configPath = path.join(workspaceRoot, ".mcp.json");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(appHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(appHome, "bin", "exclusive-dawn.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      dawn_tools: {
        command: "node",
        args: ["old.js"],
      },
    },
  }, null, 2));

  ensureClaudeProjectMcpConfig({ workspaceRoot, appHome });

  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.mcpServers.dawn_tools, buildClaudeProjectMcpServerConfig({
    workspaceRoot,
    appHome,
  }));
});
