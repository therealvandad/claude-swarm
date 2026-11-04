// Stdio MCP server the claude CLI starts for the commander session. It exposes the swarm tools
// and forwards every call to the app over the local bridge. Zero dependencies; JSON-RPC over
// newline-delimited stdio. Runs under node or under electron with ELECTRON_RUN_AS_NODE=1.
const BRIDGE_URL = process.env.SWARM_BRIDGE_URL;
const TOKEN = process.env.SWARM_BRIDGE_TOKEN;

const TOOLS = [
  {
    name: "list_sessions",
    description: "List all worker sessions with id, name, folder, status (running/idle/error), turns, cost and the last result text.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_session",
    description: "Create a new worker: a full Claude Code session working in a folder. Optionally give it its first prompt right away. Returns the session summary including its id. The folder is created if it does not exist.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Absolute path of the folder the worker works in." },
        name: { type: "string", description: "Short descriptive name, e.g. api-tests. Random if omitted." },
        prompt: { type: "string", description: "First prompt for the worker. Make it self-contained: the worker knows nothing about this conversation." },
        permission_mode: { type: "string", enum: ["acceptEdits", "bypassPermissions", "plan", "default"], description: "acceptEdits: may read and edit files but cannot run shell commands. bypassPermissions: may also run commands (install, build, test). plan: read only, writes a plan. Default acceptEdits." },
        model: { type: "string", enum: ["", "opus", "sonnet", "haiku"], description: "Model override. Empty for the account default." },
        worktree: { type: "boolean", description: "If the folder is a git repo, work in a fresh git worktree and branch so several workers can edit the same repo safely." },
      },
      required: ["folder"],
      additionalProperties: false,
    },
  },
  {
    name: "send_prompt",
    description: "Send a follow-up prompt to an existing idle worker. It continues its own conversation. Fails if the worker is still running.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" }, prompt: { type: "string" } }, required: ["session_id", "prompt"], additionalProperties: false },
  },
  {
    name: "wait_for_sessions",
    description: "Block until one of the given workers finishes its current turn, or the timeout passes (max 240 s). With no ids, waits on every running worker. If the outcome is still_running_call_again, call it again to keep waiting.",
    inputSchema: { type: "object", properties: { session_ids: { type: "array", items: { type: "string" } }, timeout_seconds: { type: "number" } }, additionalProperties: false },
  },
  {
    name: "get_output",
    description: "Get a worker's summary plus a condensed transcript of its recent activity: prompts, its text, tool calls, results and errors.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" }, max_items: { type: "number", description: "How many recent lines, default 40." } }, required: ["session_id"], additionalProperties: false },
  },
  {
    name: "stop_session",
    description: "Stop a worker's current turn immediately. The worker stays and can be prompted again.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"], additionalProperties: false },
  },
  {
    name: "remove_session",
    description: "Remove a worker from the dashboard. Its files are kept unless delete_worktree is true and it was created with a worktree.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" }, delete_worktree: { type: "boolean" } }, required: ["session_id"], additionalProperties: false },
  },
];

async function bridge(method, params) {
  if (!BRIDGE_URL || !TOKEN) throw new Error("bridge not configured (SWARM_BRIDGE_URL / SWARM_BRIDGE_TOKEN missing)");
  const r = await fetch(BRIDGE_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "swarm", version: "0.1.0" },
    } });
  }
  if (isNotification) return;
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    try {
      const result = await bridge(params.name, params.arguments || {});
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Error: " + (e.message || e) }], isError: true } });
    }
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => { if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e) } }); });
  }
});
process.stdin.on("end", () => process.exit(0));
