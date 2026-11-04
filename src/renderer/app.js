const $ = (s, r = document) => r.querySelector(s);
const api = window.swarm;
const isMac = api.platform === "darwin";

// ---------------------------------------------------------------- state
const workers = new Map(); // id -> { session, log, card, item, done, draft }
let settings = {}, pre = null;
let commander = null;      // commander session (public view) or null until a workspace is chosen
let view = "board";        // "board" (commander + workers) | <worker id>

// ---------------------------------------------------------------- boot
(async function boot() {
  settings = unwrap(await api.getSettings(), {});
  if (api.platform === "linux") $("#row-login").hidden = true;
  commander = unwrap(await api.commanderGet(), null);
  if (commander) { for (const ev of unwrap(await api.events(commander.id), [])) appendChat(ev); }
  for (const s of unwrap(await api.listSessions(), [])) {
    if (s.role === "commander") continue;
    upsertWorker(s);
    for (const ev of unwrap(await api.events(s.id), [])) appendEvent(s.id, ev);
  }
  renderCommander();
  renderSidebar();
  showView("board");

  api.onPreflight((p) => { pre = p; renderStatus(); });
  api.onEvent(({ sessionId, event }) => {
    if (commander && sessionId === commander.id) { appendChat(event); scrollToEnd($("#cmd-chat")); return; }
    appendEvent(sessionId, event);
    const w = workers.get(sessionId);
    if (w) scrollToEnd(w.log.parentElement === $("#wk-log-host") ? $("#wk-log-host") : w.log);
  });
  api.onUpdate((s) => {
    if (s.role === "commander") { commander = s; renderCommander(); renderSidebar(); return; }
    upsertWorker(s); renderSidebar(); if (view === s.id) renderWorkerToolbar(); refreshOverview();
  });
  api.onRemoved((id) => {
    const w = workers.get(id);
    if (w) { w.card.remove(); w.log.remove(); workers.delete(id); }
    if (view === id) showView("board");
    renderSidebar(); refreshOverview();
  });
  pre = unwrap(await api.preflight(false), null);
  renderStatus();
})();

function unwrap(res, fallback) {
  if (res && res.ok) return res.data;
  if (res && res.error) showBanner(res.error, true);
  return fallback;
}
function showBanner(text, isErr) { const b = $("#banner"); b.textContent = text; b.hidden = false; b.classList.toggle("err", !!isErr); }
function hideBanner() { $("#banner").hidden = true; }
function statusWord(s) {
  if (s.running) return s.status === "stopping" ? "stopping" : "running";
  if (s.status === "error") return "error";
  return s.stats && s.stats.turns > 0 ? "done" : "idle";
}
function setPill(pillEl, textEl, word) { pillEl.dataset.s = word; $(".dot", pillEl).dataset.s = word; textEl.textContent = word; }
function scrollToEnd(el, force) {
  if (!el) return;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  if (near || force) el.scrollTop = el.scrollHeight;
}
function setCwd(el, cwd) { const bdi = document.createElement("bdi"); bdi.textContent = cwd || ""; el.replaceChildren(bdi); el.title = cwd || ""; }

// ---------------------------------------------------------------- tiny safe Markdown
// Everything is HTML-escaped first; only our own tags are added afterwards, so model output can
// never inject markup. Covers what Claude actually emits: headings, bullets, numbered lists,
// fenced code, inline code, bold, italic, paragraphs.
function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function inlineMd(s) {
  return escapeHtml(s)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
}
function renderMarkdown(text) {
  const root = document.createElement("div");
  root.className = "md";
  const lines = text.split("\n");
  let html = "", i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html += "<pre><code>" + escapeHtml(buf.join("\n")) + "</code></pre>";
      continue;
    }
    const h = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (h) { html += `<h${h[1].length + 2}>${inlineMd(h[2])}</h${h[1].length + 2}>`; i++; continue; }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ""); i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) item += " " + lines[i++].trim();
        items.push("<li>" + inlineMd(item) + "</li>");
      }
      html += (ordered ? "<ol>" : "<ul>") + items.join("") + (ordered ? "</ol>" : "</ul>");
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^\s*#{1,4}\s/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++]);
    html += "<p>" + inlineMd(para.join("\n")) + "</p>";
  }
  root.innerHTML = html;
  return root;
}

// ---------------------------------------------------------------- status (sidebar footer)
function renderStatus() {
  const box = $("#status");
  box.innerHTML = "";
  const line = (text, cls = "") => { const c = document.createElement("span"); c.className = cls; c.textContent = text; box.appendChild(c); };
  if (!pre) { line("checking the claude CLI…"); return; }
  if (!pre.claude.found) {
    line("claude CLI not found", "err");
    showBanner("Claude Code CLI not found. Install it with  npm install -g @anthropic-ai/claude-code  (or the native installer), then restart, or set its path in Settings.", true);
    return;
  }
  line("claude " + pre.claude.version.replace(/\s*\(Claude Code\)/, ""), "ok");
  if (!pre.auth.loggedIn) {
    line("not logged in", "err");
    showBanner("Not logged in. Open a terminal, run  claude  once and sign in with your Claude account, then open Settings and press Save to re-check.", true);
    return;
  }
  line(pre.auth.email || "logged in", "ok");
  if (pre.planKnown) {
    line("plan: " + pre.plan, "plan " + (pre.isMax ? "ok" : (settings.requireMax ? "err" : "warn")));
    if (!pre.isMax && settings.requireMax) showBanner(`This app expects a Claude Max subscription to run many sessions at once; your account reports "${pre.plan}". Running several sessions on a smaller plan hits usage limits within minutes. You can disable the check in Settings.`, true);
    else if (!pre.isMax) showBanner(`Plan "${pre.plan}" detected. Parallel sessions will use up your limits quickly.`, false);
    else hideBanner();
  } else {
    line("plan: unknown", "warn");
    showBanner("Could not read your subscription type from the CLI. A Claude Max plan is recommended for parallel sessions.", false);
  }
}

// ---------------------------------------------------------------- views
function showView(next) {
  if (!workers.has(next)) next = "board";
  view = next;
  $("#view-board").hidden = next !== "board";
  $("#view-worker").hidden = !workers.has(next);
  // The log element of each worker lives either in its overview card or in the detail view.
  for (const [id, w] of workers) {
    const host = id === next ? $("#wk-log-host") : $(".body", w.card);
    if (w.log.parentElement !== host) host.appendChild(w.log);
    if (id !== next) w.log.scrollTop = w.log.scrollHeight; // previews show the latest activity
  }
  if (workers.has(next)) {
    const w = workers.get(next);
    $("#wk-input").value = w.draft || "";
    renderWorkerToolbar();
    scrollToEnd($("#wk-log-host"), true);
    $("#wk-input").focus();
  } else {
    scrollToEnd($("#cmd-chat"), true);
    for (const w of workers.values()) w.log.scrollTop = w.log.scrollHeight;
  }
  renderSidebar();
}
for (const b of document.querySelectorAll(".nav-item")) b.addEventListener("click", () => showView(b.dataset.view));
$("#wk-back").addEventListener("click", () => showView("board"));

// ---------------------------------------------------------------- sidebar
function renderSidebar() {
  for (const b of document.querySelectorAll(".nav-item")) b.classList.toggle("active", b.dataset.view === view);
  $("#nav-cmd-dot").dataset.s = commander ? (commander.running ? "running" : (commander.status === "error" ? "error" : "idle")) : "idle";
  const running = [...workers.values()].filter((w) => w.session.running).length;
  $("#nav-count").textContent = workers.size ? (running ? `${running}/${workers.size}` : `${workers.size}`) : "";
  const list = $("#side-list");
  list.innerHTML = "";
  if (!workers.size) {
    const d = document.createElement("div"); d.className = "side-empty"; d.textContent = "Workers the commander starts, or you add, appear here."; list.appendChild(d);
    return;
  }
  for (const [id, w] of workers) {
    const el = $("#tpl-side-item").content.firstElementChild.cloneNode(true);
    const s = w.session, word = statusWord(s);
    $(".dot", el).dataset.s = word;
    $(".name", el).textContent = s.name;
    $(".sub", el).textContent = word === "running" ? "working" : (s.stats.turns ? `${s.stats.turns}t` : "");
    el.classList.toggle("active", view === id);
    el.title = s.cwd;
    el.addEventListener("click", () => showView(id));
    list.appendChild(el);
  }
}

// ---------------------------------------------------------------- overview
function refreshOverview() {
  const none = workers.size === 0;
  $("#empty").hidden = !none;
  $("#grid").hidden = none;
  const running = [...workers.values()].filter((w) => w.session.running).length;
  const cost = [...workers.values()].reduce((a, w) => a + w.session.stats.costUsd, 0);
  $("#ov-summary").textContent = none ? "" : `${workers.size} worker${workers.size === 1 ? "" : "s"} · ${running} running · $${cost.toFixed(2)}`;
}

function upsertWorker(s) {
  let w = workers.get(s.id);
  if (!w) {
    const card = $("#tpl-card").content.firstElementChild.cloneNode(true);
    const log = document.createElement("div"); log.className = "log";
    $(".body", card).appendChild(log);
    card.addEventListener("click", () => showView(s.id));
    w = { session: s, log, card, done: false, draft: "" };
    workers.set(s.id, w);
    $("#grid").appendChild(card);
  }
  w.session = s;
  const word = statusWord(s);
  w.card.dataset.status = word;
  $(".dot", w.card).dataset.s = word;
  $(".name", w.card).textContent = s.name;
  w.card.title = `${s.name} · ${s.permissionMode}${s.model ? " · " + s.model : ""}\n${s.cwd}`;
  $(".stats", w.card).textContent = word === "running" ? "working" : `${s.stats.turns}t · $${s.stats.costUsd.toFixed(2)}`;
  refreshOverview();
}

// ---------------------------------------------------------------- worker detail
function current() { return workers.get(view) || null; }
function renderWorkerToolbar() {
  const w = current();
  if (!w) return;
  const s = w.session, word = statusWord(s);
  $("#wk-name").textContent = s.name;
  setPill($("#wk-pill"), $("#wk-pill-text"), word);
  $("#wk-meta").textContent = [s.permissionMode, s.model || (s.lastModel || "").replace(/^claude-/, ""), s.worktree ? s.worktree.branch : ""].filter(Boolean).join(" · ");
  setCwd($("#wk-cwd"), s.cwd);
  $("#wk-stats").textContent = `${s.stats.turns} turn${s.stats.turns === 1 ? "" : "s"} · $${s.stats.costUsd.toFixed(3)}`;
  const running = word === "running" || word === "stopping";
  $("#wk-stop").hidden = !running;
  $("#wk-stop").disabled = word === "stopping";
  $("#wk-send").hidden = running;
  $("#wk-input").disabled = running;
}
async function sendToWorker() {
  const w = current();
  const text = $("#wk-input").value.trim();
  if (!w || !text) return;
  const r = await api.send(w.session.id, text);
  if (!r.ok) { showBanner(r.error, true); return; }
  w.draft = ""; $("#wk-input").value = "";
}
$("#wk-send").addEventListener("click", sendToWorker);
$("#wk-input").addEventListener("input", () => { const w = current(); if (w) w.draft = $("#wk-input").value; });
$("#wk-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendToWorker(); } });
$("#wk-stop").addEventListener("click", () => { const w = current(); if (w) api.stop(w.session.id); });
$("#wk-open").addEventListener("click", () => { const w = current(); if (w) api.openPath(w.session.cwd); });
$("#wk-remove").addEventListener("click", () => { const w = current(); if (w) confirmRemove(w.session); });

function confirmRemove(s) {
  const dlg = $("#dlg-remove");
  $("#remove-text").textContent = `"${s.name}" will be removed from the dashboard. Files in ${s.cwd} are kept unless you tick the box below.`;
  $("#remove-wt-row").hidden = !s.worktree;
  $("#form-remove").onsubmit = async (e) => {
    e.preventDefault();
    await api.removeSession(s.id, { deleteWorktree: !!e.target.deleteWorktree.checked });
    dlg.close();
  };
  dlg.showModal();
}
$("#btn-remove-cancel").addEventListener("click", () => $("#dlg-remove").close());

// ---------------------------------------------------------------- worker transcript rendering
function appendEvent(id, ev) {
  const w = workers.get(id);
  if (!w) return;
  const add = (cls, text) => { const d = document.createElement("div"); d.className = "ev " + cls; d.textContent = text; w.log.appendChild(d); return d; };
  switch (ev.type) {
    case "prompt": add("prompt", ev.text); break;
    case "system":
      if (ev.subtype === "init") add("sys", `session started · ${(ev.model || "").replace(/^claude-/, "")}${ev.permissionMode ? " · " + ev.permissionMode : ""}`);
      break;
    case "assistant":
      for (const block of (ev.message && ev.message.content) || []) {
        if (block.type === "text" && block.text.trim()) { const d = add("text", ""); d.appendChild(renderMarkdown(block.text.trim())); }
        else if (block.type === "tool_use") {
          const d = add("tool", block.name);
          const a = document.createElement("span"); a.className = "arg"; a.textContent = summarizeInput(block.input); d.appendChild(a);
        }
      }
      break;
    case "user":
      for (const block of (ev.message && ev.message.content) || []) {
        if (block.type === "tool_result") {
          const txt = flattenResult(block.content);
          if (!txt) continue;
          const short = txt.length > 200 ? txt.slice(0, 200).replace(/\s+/g, " ") + " …" : txt.replace(/\s+/g, " ");
          const d = add("toolres", short);
          if (txt.length > 200) d.addEventListener("click", (e) => { e.stopPropagation(); d.classList.toggle("open"); d.textContent = d.classList.contains("open") ? txt : short; });
        }
      }
      break;
    case "result": {
      const ok = ev.subtype === "success" && !ev.is_error;
      const secs = ((ev.duration_ms || 0) / 1000).toFixed(1);
      const cost = ev.total_cost_usd != null ? ` · $${Number(ev.total_cost_usd).toFixed(3)}` : "";
      add("result" + (ok ? "" : " err"), (ok ? "done" : "failed: " + (ev.subtype || "error")) + ` · ${secs}s · ${ev.num_turns || 0} steps${cost}` + (!ok && ev.result ? "\n" + ev.result : ""));
      w.done = true;
      break;
    }
    case "stderr": add("stderr", ev.text); break;
    case "raw": add("sys", ev.text); break;
    default: break;
  }
  while (w.log.children.length > 600) w.log.firstElementChild.remove();
}
function summarizeInput(input) {
  if (!input || typeof input !== "object") return "";
  const v = input.command || input.file_path || input.path || input.pattern || input.query || input.url || input.description || input.prompt;
  if (typeof v === "string") return v.length > 140 ? v.slice(0, 140) + "…" : v;
  const j = JSON.stringify(input);
  return j.length > 140 ? j.slice(0, 140) + "…" : j;
}
function flattenResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  return "";
}

// ---------------------------------------------------------------- commander
const chatEl = $("#cmd-chat"), cmdInput = $("#cmd-input"), cmdSend = $("#cmd-send"), cmdStop = $("#cmd-stop");

function renderCommander() {
  const has = !!commander;
  $("#cmd-setup").hidden = has;
  chatEl.hidden = !has;
  $("#cmd-footer").hidden = !has;
  if (!has) { setCwd($("#cmd-cwd"), ""); setPill($("#cmd-pill"), $("#cmd-pill-text"), "idle"); return; }
  setCwd($("#cmd-cwd"), commander.cwd);
  const word = commander.running ? (commander.status === "stopping" ? "stopping" : "working") : (commander.status === "error" ? "error" : "idle");
  setPill($("#cmd-pill"), $("#cmd-pill-text"), word);
  const running = word === "working" || word === "stopping";
  cmdSend.hidden = running;
  cmdStop.hidden = !running;
  cmdStop.disabled = word === "stopping";
  cmdInput.disabled = running;
}
async function chooseWorkspace() {
  const folder = unwrap(await api.pickFolder(), null);
  if (!folder) return;
  const r = await api.commanderSetup(folder);
  if (!r.ok) { showBanner(r.error, true); return; }
  commander = r.data;
  renderCommander(); renderSidebar();
  if (!chatEl.children.length) addMsg("status", "workspace set");
  cmdInput.focus();
}
$("#cmd-pick").addEventListener("click", chooseWorkspace);
$("#cmd-folder").addEventListener("click", chooseWorkspace);
async function sendToCommander() {
  const text = cmdInput.value.trim();
  if (!text || !commander) return;
  const r = await api.commanderSend(text);
  if (!r.ok) { showBanner(r.error, true); return; }
  cmdInput.value = "";
}
cmdSend.addEventListener("click", sendToCommander);
cmdInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendToCommander(); } });
cmdStop.addEventListener("click", () => commander && api.stop(commander.id));

function addMsg(cls, text) { const d = document.createElement("div"); d.className = "msg " + cls; d.textContent = text; chatEl.appendChild(d); return d; }
function describeTool(name, input) {
  const short = name.replace(/^mcp__swarm__/, "");
  const i = input || {};
  switch (short) {
    case "create_session": return [short, i.name ? "“" + i.name + "”" : "", i.folder ? "in " + i.folder : ""].filter(Boolean).join(" ");
    case "send_prompt": return short + (i.prompt ? ": " + i.prompt.slice(0, 90) + (i.prompt.length > 90 ? "…" : "") : "");
    case "wait_for_sessions": return "waiting for workers…";
    case "get_output": return "reading a worker's output";
    case "stop_session": return "stopping a worker";
    case "remove_session": return "removing a worker";
    case "list_sessions": return "listing workers";
    default: return short + " " + summarizeInput(i);
  }
}
function appendChat(ev) {
  switch (ev.type) {
    case "prompt": addMsg("user", ev.text); break;
    case "assistant":
      for (const block of (ev.message && ev.message.content) || []) {
        if (block.type === "text" && block.text.trim()) addMsg("bot", "").appendChild(renderMarkdown(block.text.trim()));
        else if (block.type === "tool_use" && block.name !== "ToolSearch") addMsg("tool", describeTool(block.name, block.input));
      }
      break;
    case "result": {
      const ok = ev.subtype === "success" && !ev.is_error;
      addMsg(ok ? "status" : "err", ok ? `${((ev.duration_ms || 0) / 1000).toFixed(0)}s` : "failed: " + (ev.subtype || "error") + (ev.result ? "\n" + ev.result : ""));
      break;
    }
    case "stderr": addMsg("err", ev.text); break;
    default: break;
  }
  while (chatEl.children.length > 800) chatEl.firstElementChild.remove();
}

// ---------------------------------------------------------------- new worker dialog
const dlgNew = $("#dlg-new"), formNew = $("#form-new");
async function openNew() {
  formNew.reset();
  $("#new-error").hidden = true;
  formNew.name.value = unwrap(await api.randomName(), "new-worker");
  const last = workers.size ? [...workers.values()].pop().session.cwd : (commander ? commander.cwd : "");
  if (last) formNew.cwd.value = last;
  dlgNew.showModal();
}
$("#btn-new").addEventListener("click", openNew);
$("#btn-new-cancel").addEventListener("click", () => dlgNew.close());
$("#btn-browse").addEventListener("click", async () => { const p = unwrap(await api.pickFolder(), null); if (p) formNew.cwd.value = p; });
formNew.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = formNew;
  const r = await api.createSession({ name: f.name.value.trim(), cwd: f.cwd.value.trim(), worktree: f.worktree.checked, permissionMode: f.permissionMode.value, model: f.model.value });
  if (!r.ok) { $("#new-error").textContent = r.error; $("#new-error").hidden = false; return; }
  dlgNew.close();
  const prompt = f.prompt.value.trim();
  if (prompt) { const s = await api.send(r.data.id, prompt); if (!s.ok) showBanner(s.error, true); }
  showView(r.data.id);
});

// ---------------------------------------------------------------- settings
const dlgSettings = $("#dlg-settings"), formSettings = $("#form-settings");
$("#btn-settings").addEventListener("click", () => {
  formSettings.claudePath.value = settings.claudePath || "";
  formSettings.requireMax.checked = !!settings.requireMax;
  formSettings.closeToTray.checked = !!settings.closeToTray;
  formSettings.startWithWindows.checked = !!settings.startWithWindows;
  dlgSettings.showModal();
});
$("#btn-settings-cancel").addEventListener("click", () => dlgSettings.close());
formSettings.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = formSettings;
  const r = await api.setSettings({ claudePath: f.claudePath.value.trim(), requireMax: f.requireMax.checked, closeToTray: f.closeToTray.checked, startWithWindows: f.startWithWindows.checked });
  if (r.ok) { settings = r.data.settings; pre = r.data.pre; renderStatus(); }
  dlgSettings.close();
});

// ---------------------------------------------------------------- broadcast, stop all, shortcuts
$("#broadcast-send").addEventListener("click", broadcast);
$("#broadcast-input").addEventListener("keydown", (e) => { if (e.key === "Enter") broadcast(); });
async function broadcast() {
  const text = $("#broadcast-input").value.trim();
  if (!text) return;
  let sent = 0;
  for (const w of workers.values()) {
    if (w.session.running) continue;
    const r = await api.send(w.session.id, text);
    if (r.ok) sent++; else showBanner(r.error, true);
  }
  if (sent) $("#broadcast-input").value = "";
}
$("#btn-stop-all").addEventListener("click", () => api.stopAll());
api.onUiSettings(() => $("#btn-settings").click());
api.onUiNewWorker(() => openNew());
api.onUiView(() => showView("board"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && view !== "board" && !document.querySelector("dialog[open]")) { showView("board"); return; }
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod) return;
  if (e.key === "n" || e.key === "N") { e.preventDefault(); openNew(); }
  else if (e.key === "1") { e.preventDefault(); showView("board"); }
  else if (e.key === "2") { e.preventDefault(); showView("board"); if (commander) $("#cmd-input").focus(); }
  else if (e.key === "," ) { e.preventDefault(); $("#btn-settings").click(); }
});
