// Local HTTP bridge: the commander's MCP tool server (a separate process started by the claude CLI)
// calls into the running app through this. Bound to 127.0.0.1 with a random port and a bearer token.
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const randomName = require("./names");

function startBridge(manager) {
  const token = crypto.randomBytes(24).toString("hex");
  const server = http.createServer((req, res) => {
    const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method !== "POST" || req.url !== "/rpc") return reply(404, { error: "not found" });
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: "unauthorized" });
    let body = "";
    req.on("data", (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on("end", async () => {
      try {
        const { method, params } = JSON.parse(body || "{}");
        reply(200, { result: await dispatch(manager, method, params || {}) });
      } catch (e) {
        reply(200, { error: e && e.message ? e.message : String(e) });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, token, url: `http://127.0.0.1:${server.address().port}/rpc` }));
  });
}

function summary(manager, s) {
  return {
    id: s.id,
    name: s.name,
    folder: s.cwd,
    branch: s.worktree ? s.worktree.branch : null,
    status: manager.procs.has(s.id) ? "running" : s.status,
    turns: s.stats.turns,
    cost_usd: Number(s.stats.costUsd.toFixed(3)),
    permission_mode: s.permissionMode,
    model: s.model || null,
    last_result: s.lastResult ? s.lastResult.slice(0, 1500) : null,
  };
}

function condense(events, max) {
  const out = [];
  for (const ev of events) {
    if (ev.type === "prompt") out.push("PROMPT: " + ev.text.slice(0, 500));
    else if (ev.type === "assistant") {
      for (const b of (ev.message && ev.message.content) || []) {
        if (b.type === "text" && b.text.trim()) out.push("WORKER: " + b.text.trim().slice(0, 1500));
        else if (b.type === "tool_use") out.push("TOOL: " + b.name + " " + JSON.stringify(b.input).slice(0, 200));
      }
    } else if (ev.type === "result") out.push(`RESULT: ${ev.subtype} after ${((ev.duration_ms || 0) / 1000).toFixed(1)}s`);
    else if (ev.type === "stderr") out.push("ERROR: " + ev.text.slice(0, 500));
  }
  return out.slice(-max);
}

async function dispatch(manager, method, p) {
  const worker = (id) => {
    const s = manager.get(id);
    if (!s) throw new Error("No session with id " + id + ". Call list_sessions to see valid ids.");
    if (s.role === "commander") throw new Error("That id is the commander itself, not a worker.");
    return s;
  };
  switch (method) {
    case "list_sessions":
      return manager.list().filter((s) => s.role !== "commander").map((s) => summary(manager, s));

    case "create_session": {
      if (!p.folder) throw new Error("folder is required");
      fs.mkdirSync(p.folder, { recursive: true });
      const s = await manager.create({
        name: p.name || randomName(), cwd: p.folder,
        permissionMode: p.permission_mode || "acceptEdits", model: p.model || "", worktree: !!p.worktree,
      });
      if (p.prompt) manager.send(s.id, p.prompt);
      return summary(manager, manager.get(s.id));
    }

    case "send_prompt": {
      const s = worker(p.session_id);
      if (!p.prompt) throw new Error("prompt is required");
      manager.send(s.id, p.prompt);
      return summary(manager, s);
    }

    case "stop_session": { const s = worker(p.session_id); await manager.stop(s.id); return summary(manager, s); }

    case "remove_session": { worker(p.session_id); await manager.remove(p.session_id, { deleteWorktree: !!p.delete_worktree }); return { removed: p.session_id }; }

    case "get_output": {
      const s = worker(p.session_id);
      return { ...summary(manager, s), recent: condense(manager.recentEvents(s.id), Number(p.max_items) || 40) };
    }

    case "wait_for_sessions": {
      let ids = Array.isArray(p.session_ids) && p.session_ids.length ? p.session_ids : null;
      if (!ids) ids = manager.list().filter((s) => s.role !== "commander" && manager.procs.has(s.id)).map((s) => s.id);
      ids.forEach(worker);
      const timeout = Math.min(Math.max(Number(p.timeout_seconds) || 120, 5), 240) * 1000;
      const running = () => ids.filter((id) => manager.procs.has(id));
      let finished = running().length === 0 ? "none_running" : "timeout";
      if (finished === "timeout") {
        finished = await new Promise((resolve) => {
          const t = setTimeout(() => { manager.off("update", h); resolve("timeout"); }, timeout);
          const h = (u) => { if (ids.includes(u.id) && !u.running) { clearTimeout(t); manager.off("update", h); resolve(u.id); } };
          manager.on("update", h);
        });
      }
      return {
        outcome: finished === "timeout" ? "still_running_call_again" : finished === "none_running" ? "none_were_running" : "a_session_finished",
        finished_session: finished !== "timeout" && finished !== "none_running" ? finished : null,
        still_running: running(),
        sessions: ids.map((id) => summary(manager, manager.get(id))),
      };
    }

    default:
      throw new Error("Unknown method " + method);
  }
}

module.exports = { startBridge };
