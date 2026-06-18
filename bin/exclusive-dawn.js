#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

// Singleton guard for "start" command: exit if another bridge instance is already running.
// Uses two methods so the check works regardless of whether DAWN_STATE_DIR is set
// (clawd-on-desk and other launchers may not load .env before spawning this process).
if (process.argv[2] === "start") {
  let alreadyRunning = false;

  // Method 1: PID file check (works when env is loaded by the launcher).
  // Try known state dirs: env var, then common install locations.
  const stateDirCandidates = [
    process.env.DAWN_STATE_DIR,
    path.join(os.homedir(), ".exclusive-dawn"),
    "D:\\GitHub\\.exclusive-dawn",
  ].filter(Boolean);

  for (const stateDir of stateDirCandidates) {
    const pidFile =
      process.platform === "win32"
        ? path.join(stateDir, "windows-dawn-bridge.pid")
        : path.join(stateDir, "logs", "shared-wechat.pid");
    try {
      const existingPid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      if (existingPid > 0 && existingPid !== process.pid && existingPid !== process.ppid) {
        try {
          process.kill(existingPid, 0);
          alreadyRunning = true;
          break;
        } catch {
          // stale PID, keep looking
        }
      }
    } catch {
      // no PID file in this candidate dir
    }
  }

  // Method 2: Process scan fallback — count other node processes running this same script.
  // Reliable even when no PID file exists yet (race-condition window on first start).
  if (!alreadyRunning && process.platform === "win32") {
    try {
      const thisScript = path.resolve(__filename);
      const out = execSync(
        `wmic process where "name='node.exe'" get ProcessId,CommandLine /format:csv`,
        { timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      const lines = out.split(/\r?\n/).filter((l) => l.includes("exclusive-dawn.js") && l.includes("start"));
      const otherCount = lines.filter((l) => !l.includes(String(process.pid))).length;
      if (otherCount > 0) alreadyRunning = true;
    } catch {
      // wmic unavailable or timed out — skip this check
    }
  }

  if (alreadyRunning) {
    console.log("[dawn] bridge already running, exiting.");
    process.exit(0);
  }
}

const { main } = require("../src/index");

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[dawn] ${message}`);
  process.exitCode = 1;
});

