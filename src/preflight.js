// Finds the Claude Code CLI and reads its login / subscription state.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const WIN = process.platform === "win32";

function quoteIfNeeded(cmd) {
  return /\s/.test(cmd) && !/^".*"$/.test(cmd) ? `"${cmd}"` : cmd;
}

// Child env: strip markers that make Claude Code think it is nested inside another session.
function childEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

// Spawn without a shell whenever possible. On Windows a bare name or a .cmd shim needs cmd.exe;
// the command line is then built from app-controlled args only (prompts travel over stdin).
function needsShell(cmd) {
  return WIN && !/\.exe$/i.test(cmd);
}
function spawnCmd(cmd, args, opts = {}) {
  const base = { ...opts, windowsHide: true, env: { ...childEnv(), ...(opts.env || {}) } };
  if (!needsShell(cmd)) return spawn(cmd, args, base);
  const line = [cmd, ...args].map(quoteIfNeeded).join(" ");
  return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...base, windowsVerbatimArguments: true });
}

function run(cmd, args, { cwd, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCmd(cmd, args, { cwd });
    } catch (e) {
      return resolve({ code: -1, stdout: "", stderr: String(e) });
    }
    let stdout = "", stderr = "";
    const t = setTimeout(() => { try { child.kill(); } catch {} }, timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, stdout, stderr: stderr + String(e) }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
  });
}

// Apps started from the macOS Dock or a Linux launcher get a minimal PATH, not the one your shell
// has (where npm, Homebrew or the native installer put `claude`). Ask the login shell for its PATH once.
let pathFixed = false;
function fixPath() {
  if (WIN || pathFixed) return Promise.resolve();
  pathFixed = true;
  const shell = process.env.SHELL || "/bin/bash";
  return new Promise((resolve) => {
    let out = "";
    let child;
    try { child = spawn(shell, ["-ilc", 'echo -n "__PATH__$PATH"'], { env: childEnv(), windowsHide: true }); }
    catch { return resolve(); }
    const t = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 6000);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => { clearTimeout(t); resolve(); });
    child.on("close", () => {
      clearTimeout(t);
      const m = out.match(/__PATH__(.*)$/s);
      if (m && m[1].trim()) {
        const merged = [...new Set([...m[1].trim().split(":"), ...(process.env.PATH || "").split(":")])].filter(Boolean);
        process.env.PATH = merged.join(":");
      }
      resolve();
    });
  });
}

function candidates(override) {
  const home = os.homedir();
  const list = [];
  if (override && override.trim()) list.push(override.trim());
  if (WIN && process.env.APPDATA) {
    // The npm shim claude.cmd only forwards to this exe; calling it directly avoids a shell.
    list.push(path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
  }
  list.push("claude"); // whatever is on PATH (after fixPath on mac/linux)
  if (WIN && process.env.APPDATA) list.push(path.join(process.env.APPDATA, "npm", "claude.cmd"));
  list.push(path.join(home, ".local", "bin", "claude"));      // native installer (curl ... | bash)
  list.push(path.join(home, ".claude", "local", "claude"));   // older local install
  if (!WIN) {
    list.push("/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude");
    list.push(path.join(home, ".npm-global", "bin", "claude"), path.join(home, ".volta", "bin", "claude"));
  }
  return list;
}

async function resolveClaude(override) {
  for (const c of candidates(override)) {
    const r = await run(c, ["--version"], { timeout: 15000 });
    if (r.code === 0 && /\d+\.\d+/.test(r.stdout)) {
      return { found: true, path: c, version: r.stdout.trim().split("\n")[0] };
    }
  }
  return { found: false, path: null, version: null };
}

const NO_AUTH = { loggedIn: false, email: null, orgName: null, subscriptionType: null, loginExpiresAt: null, source: "none" };

async function authStatus(claudePath) {
  const r = await run(claudePath, ["auth", "status"]);
  const start = r.stdout.indexOf("{");
  if (start >= 0) {
    try {
      const j = JSON.parse(r.stdout.slice(start));
      return {
        loggedIn: !!j.loggedIn,
        email: j.email || null,
        orgName: j.orgName || null,
        subscriptionType: j.subscriptionType || null,
        loginExpiresAt: j.loginExpiresAt || null,
        source: "claude auth status",
      };
    } catch {}
  }
  // Older CLI without `auth status`: fall back to the config file (no plan info there).
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    const a = j.oauthAccount;
    if (a) return { ...NO_AUTH, loggedIn: true, email: a.emailAddress || null, orgName: a.organizationName || null, source: "~/.claude.json" };
  } catch {}
  return NO_AUTH;
}

async function preflight(settings = {}) {
  await fixPath();
  const claude = await resolveClaude(settings.claudePath);
  const auth = claude.found ? await authStatus(claude.path) : NO_AUTH;
  const plan = auth.subscriptionType;
  return { claude, auth, plan, planKnown: !!plan, isMax: plan === "max", checkedAt: Date.now() };
}

module.exports = { preflight, run, spawnCmd, fixPath, candidates, WIN };
