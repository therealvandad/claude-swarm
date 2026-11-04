// SessionManager: one Claude Code conversation per session. Each turn is a `claude -p` process
// whose stream-json output is parsed line by line and forwarded as events.
const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { run, spawnCmd, WIN } = require("./preflight");
const commanderPrompt = require("./commander-prompt");

const MAX_EVENTS = 400;
const PERMISSION_MODES = ["acceptEdits", "plan", "default", "bypassPermissions"];

class SessionManager extends EventEmitter {
  constructor({ dataDir }) {
    super();
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "sessions.json");
    this.logDir = path.join(dataDir, "logs");
    fs.mkdirSync(this.logDir, { recursive: true });
    this.sessions = new Map();
    this.procs = new Map();
    this.events = new Map(); // id -> recent events (memory only)
    this.claudePath = "claude";
    this.commanderConfig = null; // { mcpConfigPath } set by main once the bridge is up
    this.load();
  }

  setClaudePath(p) { if (p) this.claudePath = p; }

  load() {
    try {
      const list = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const s of list) {
        s.status = "idle";
        s.startedAt = null;
        if (!s.role) s.role = "worker";
        this.sessions.set(s.id, s);
        this.events.set(s.id, this.loadEvents(s.id));
      }
    } catch {}
  }

  // Restore recent history from the per-session log so the UI is not empty after a restart.
  loadEvents(id) {
    try {
      const lines = fs.readFileSync(path.join(this.logDir, id + ".jsonl"), "utf8").split("\n").filter(Boolean).slice(-MAX_EVENTS);
      return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  commander() { return this.list().find((s) => s.role === "commander") || null; }

  save() {
    const list = [...this.sessions.values()].map(({ status, startedAt, ...rest }) => rest);
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() { return [...this.sessions.values()]; }
  get(id) { return this.sessions.get(id); }
  recentEvents(id) { return this.events.get(id) || []; }
  runningCount() { return this.procs.size; }

  async create({ name, cwd, permissionMode = "acceptEdits", model = "", worktree = false, role = "worker" }) {
    if (!cwd || !fs.existsSync(cwd)) throw new Error("Folder does not exist: " + cwd);
    if (!PERMISSION_MODES.includes(permissionMode)) permissionMode = "acceptEdits";
    name = (name || "").trim() || "session";
    const id = crypto.randomUUID();
    let wt = null;
    if (worktree) wt = await createWorktree(cwd, name);
    const s = {
      id, name, role, cwd: wt ? wt.cwd : cwd, permissionMode, model: model || "",
      worktree: wt, claudeSessionId: null, lastModel: null, createdAt: Date.now(),
      stats: { costUsd: 0, turns: 0, durationMs: 0 }, lastResult: null, status: "idle", startedAt: null,
    };
    this.sessions.set(id, s);
    this.events.set(id, []);
    this.save();
    this.emit("update", this.public(s));
    return this.public(s);
  }

  async remove(id, { deleteWorktree = false } = {}) {
    const s = this.sessions.get(id);
    if (!s) return;
    await this.stop(id);
    if (deleteWorktree && s.worktree) {
      await run("git", ["worktree", "remove", "--force", s.worktree.cwd], { cwd: s.worktree.repo });
      await run("git", ["branch", "-D", s.worktree.branch], { cwd: s.worktree.repo });
    }
    this.sessions.delete(id);
    this.events.delete(id);
    this.save();
    this.emit("removed", id);
  }

  public(s) { return { ...s, running: this.procs.has(s.id) }; }

  push(id, event) {
    const arr = this.events.get(id);
    if (!arr) return;
    arr.push(event);
    if (arr.length > MAX_EVENTS) arr.splice(0, arr.length - MAX_EVENTS);
    try { fs.appendFileSync(path.join(this.logDir, id + ".jsonl"), JSON.stringify(event) + "\n"); } catch {}
    this.emit("event", { sessionId: id, event });
  }

  send(id, prompt) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("Unknown session");
    if (this.procs.has(id)) throw new Error("Session is still working. Stop it first or wait.");
    if (!prompt || !prompt.trim()) throw new Error("Empty prompt");

    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (s.permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
    else if (s.permissionMode && s.permissionMode !== "default") args.push("--permission-mode", s.permissionMode);
    if (s.model) args.push("--model", s.model);
    if (s.claudeSessionId) args.push("--resume", s.claudeSessionId);

    const env = {};
    if (s.role === "commander") {
      if (!this.commanderConfig) throw new Error("The commander is not ready yet (bridge not started).");
      args.push(
        "--mcp-config", this.commanderConfig.mcpConfigPath, "--strict-mcp-config",
        "--allowedTools", "mcp__swarm,Read,Glob,Grep",
        "--append-system-prompt", commanderPrompt(s.cwd),
      );
      env.MCP_TOOL_TIMEOUT = "600000"; // wait_for_sessions can block for minutes
    }

    // detached on mac/linux puts the CLI and its children in their own process group, so Stop can
    // kill the whole tree with one signal (Windows uses taskkill /t instead).
    const child = spawnCmd(this.claudePath, args, { cwd: s.cwd, env, detached: !WIN });
    this.procs.set(id, child);
    s.status = "running";
    s.startedAt = Date.now();
    this.push(id, { type: "prompt", text: prompt, ts: Date.now() });
    this.emit("update", this.public(s));

    child.stdin.on("error", () => {});
    child.stdin.write(prompt);
    child.stdin.end();

    let buf = "", stderr = "", gotResult = false;
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { ev = { type: "raw", text: line }; }
        this.absorb(s, ev);
        if (ev.type === "result") gotResult = true;
        this.push(id, ev);
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    child.on("error", (e) => this.push(id, { type: "stderr", text: String(e) }));
    child.on("close", (code) => {
      if (buf.trim()) { try { const ev = JSON.parse(buf); this.absorb(s, ev); this.push(id, ev); } catch {} }
      this.procs.delete(id);
      if (s.status === "stopping") { s.status = "idle"; this.push(id, { type: "stderr", text: "stopped" }); }
      else if (code === 0 || gotResult) s.status = "idle";
      else {
        s.status = "error";
        this.push(id, { type: "stderr", text: (stderr.trim() || `claude exited with code ${code}`).slice(-2000) });
      }
      s.startedAt = null;
      this.save();
      this.emit("update", this.public(s));
    });
    return this.public(s);
  }

  absorb(s, ev) {
    if (ev.type === "system" && ev.subtype === "init") {
      if (ev.session_id) s.claudeSessionId = ev.session_id;
      if (ev.model) s.lastModel = ev.model;
    } else if (ev.type === "result") {
      if (ev.session_id) s.claudeSessionId = ev.session_id;
      s.stats.costUsd += Number(ev.total_cost_usd) || 0;
      s.stats.turns += 1;
      s.stats.durationMs += Number(ev.duration_ms) || 0;
      s.lastResult = typeof ev.result === "string" ? ev.result.slice(0, 4000) : (ev.errors ? JSON.stringify(ev.errors).slice(0, 2000) : null);
      s.lastResultAt = Date.now();
    }
  }

  async stop(id) {
    const child = this.procs.get(id);
    const s = this.sessions.get(id);
    if (!child) return;
    if (s) { s.status = "stopping"; this.emit("update", this.public(s)); }
    await killTree(child.pid);
  }

  async stopAll() {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id)));
  }
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (WIN) {
      const k = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
      k.on("close", () => resolve());
      k.on("error", () => resolve());
    } else {
      const signal = (sig) => { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} } };
      signal("SIGTERM");
      // The CLI normally exits on SIGTERM; make sure a stuck tree still goes away.
      setTimeout(() => signal("SIGKILL"), 4000).unref();
      resolve();
    }
  });
}

async function createWorktree(repoCwd, name) {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: repoCwd });
  if (top.code !== 0) throw new Error("Not a git repository, so a worktree cannot be created: " + repoCwd);
  const repo = top.stdout.trim();
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "-");
  const wtPath = path.join(path.dirname(repo), `${path.basename(repo)}-${safe}`);
  const branch = `swarm/${safe}`;
  if (fs.existsSync(wtPath)) throw new Error("Worktree folder already exists: " + wtPath);
  const r = await run("git", ["worktree", "add", "-b", branch, wtPath], { cwd: repo });
  if (r.code !== 0) throw new Error("git worktree add failed: " + (r.stderr || r.stdout).trim());
  return { cwd: wtPath, branch, repo };
}

module.exports = { SessionManager, PERMISSION_MODES };
