const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const { preflight } = require("./preflight");
const { SessionManager } = require("./sessions");
const { startBridge } = require("./bridge");
const randomName = require("./names");

let win = null, tray = null, manager = null, pre = null, quitting = false;
const PLATFORM = process.platform;
const ASSETS = path.join(__dirname, "..", "assets");
// Window icon: .ico on Windows, .png elsewhere (macOS takes the icon from the app bundle).
const WINDOW_ICON = PLATFORM === "win32" ? path.join(ASSETS, "icon.ico") : path.join(ASSETS, "icon.png");
function trayImage() {
  if (PLATFORM === "darwin") {
    // Template image: black + alpha, macOS tints it for light and dark menu bars; @2x is picked up automatically.
    const img = nativeImage.createFromPath(path.join(ASSETS, "trayTemplate.png"));
    img.setTemplateImage(true);
    return img;
  }
  if (PLATFORM === "win32") return nativeImage.createFromPath(path.join(ASSETS, "icon.ico"));
  return nativeImage.createFromPath(path.join(ASSETS, "tray.png"));
}
const CAN_AUTOSTART = PLATFORM !== "linux"; // setLoginItemSettings is a no-op on Linux

// ---- settings (per-user app data: %APPDATA%, ~/Library/Application Support, ~/.config) ----------
const DEFAULTS = { claudePath: "", requireMax: true, closeToTray: true, startWithWindows: false, windowBounds: null };
let settings = { ...DEFAULTS };
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) }; } catch {}
}
function saveSettings(next) {
  settings = { ...settings, ...next };
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  const tmp = settingsFile() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, settingsFile());
  if (app.isPackaged && CAN_AUTOSTART) app.setLoginItemSettings({ openAtLogin: !!settings.startWithWindows, path: process.execPath });
  buildTray();
}

// Remember where the window was, but only restore it onto a display that still exists.
function savedBounds() {
  const b = settings.windowBounds;
  if (!b || typeof b.width !== "number") return null;
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x >= a.x - 50 && b.y >= a.y - 50 && b.x < a.x + a.width - 100 && b.y < a.y + a.height - 100;
  });
  return onScreen ? b : { width: b.width, height: b.height };
}
let boundsTimer = null;
function rememberBounds() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    settings.windowBounds = win.getBounds();
    try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {}
  }, 400);
}

async function refreshPreflight() {
  pre = await preflight(settings);
  manager.setClaudePath(pre.claude.found ? pre.claude.path : (settings.claudePath || "claude"));
  console.log("[swarm] preflight", JSON.stringify({ cli: pre.claude.version, path: pre.claude.path, loggedIn: pre.auth.loggedIn, plan: pre.plan }));
  if (win && !win.isDestroyed()) win.webContents.send("preflight", pre);
  return pre;
}

// ---- single instance -------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(async () => {
    loadSettings();
    manager = new SessionManager({ dataDir: app.getPath("userData") });
    manager.on("event", (m) => win && !win.isDestroyed() && win.webContents.send("session:event", m));
    manager.on("update", (s) => { buildTray(); win && !win.isDestroyed() && win.webContents.send("session:update", s); });
    manager.on("removed", (id) => { buildTray(); win && !win.isDestroyed() && win.webContents.send("session:removed", id); });
    registerIpc();
    createWindow();
    buildTray();
    await startCommanderBridge();
    await refreshPreflight();
  });

  app.on("window-all-closed", () => { /* keep running in the tray */ });
  app.on("activate", () => showWindow());
  app.on("before-quit", (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    const done = () => { if (tray) { tray.destroy(); tray = null; } app.quit(); };
    if (manager) manager.stopAll().then(done, done); else done();
  });
}

// The commander's tools live in an MCP server process that the claude CLI starts. It reaches the
// app through a local bridge; the config file tells the CLI how to start it.
async function startCommanderBridge() {
  const bridge = await startBridge(manager);
  const serverScript = path.join(__dirname, "mcp-server.js").replace("app.asar", "app.asar.unpacked");
  const mcpConfigPath = path.join(app.getPath("userData"), "mcp-swarm.json");
  fs.writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      swarm: {
        command: process.execPath,
        args: [serverScript],
        env: { ELECTRON_RUN_AS_NODE: "1", SWARM_BRIDGE_URL: bridge.url, SWARM_BRIDGE_TOKEN: bridge.token },
      },
    },
  }, null, 2));
  manager.commanderConfig = { mcpConfigPath };
  console.log("[swarm] bridge on", bridge.url);
}

function createWindow() {
  const bounds = savedBounds() || {};
  win = new BrowserWindow({
    width: bounds.width || 1320, height: bounds.height || 860, x: bounds.x, y: bounds.y,
    minWidth: 760, minHeight: 520,
    backgroundColor: "#121316", title: "Claude Swarm", icon: WINDOW_ICON, show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  Menu.setApplicationMenu(buildAppMenu());
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.on("resize", rememberBounds);
  win.on("move", rememberBounds);
  win.webContents.on("did-finish-load", () => console.log("[swarm] renderer loaded"));
  win.webContents.on("console-message", (_e, level, message) => { if (level >= 2) console.log("[renderer]", message); });
  win.on("close", (e) => {
    if (!quitting && settings.closeToTray) { e.preventDefault(); win.hide(); }
  });
  win.webContents.on("before-input-event", (_, input) => {
    if (input.key === "F12" && input.type === "keyDown") win.webContents.toggleDevTools();
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else { win.show(); win.focus(); }
}

// macOS needs a real application menu for Cmd+C/V/X/A and Cmd+Q to work; elsewhere the menu bar stays hidden.
function buildAppMenu() {
  if (PLATFORM !== "darwin") return null;
  return Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: "about" }, { type: "separator" },
      { label: "Settings…", accelerator: "Cmd+,", click: () => win && win.webContents.send("ui:settings") },
      { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" },
    ] },
    { label: "File", submenu: [
      { label: "New Worker", accelerator: "Cmd+N", click: () => win && win.webContents.send("ui:new-worker") },
      { type: "separator" }, { role: "close" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [
      { label: "Overview", accelerator: "Cmd+1", click: () => win && win.webContents.send("ui:view", "overview") },
      { label: "Commander", accelerator: "Cmd+2", click: () => win && win.webContents.send("ui:view", "commander") },
      { type: "separator" }, { role: "togglefullscreen" }, { role: "toggleDevTools" },
    ] },
    { role: "windowMenu" },
  ]);
}

function buildTray() {
  const n = manager ? manager.runningCount() : 0;
  const total = manager ? manager.sessions.size : 0;
  if (!tray) {
    try { tray = new Tray(trayImage()); } catch (e) { console.log("[swarm] no tray:", e.message); return; }
    tray.on("click", () => showWindow());
    tray.on("double-click", () => showWindow());
  }
  tray.setToolTip(`Claude Swarm: ${n} of ${total} session${total === 1 ? "" : "s"} working`);
  const items = [
    { label: "Open Claude Swarm", click: () => showWindow() },
    { label: `${n} working, ${total} total`, enabled: false },
    { type: "separator" },
    { label: "Stop all sessions", enabled: n > 0, click: () => manager.stopAll() },
  ];
  if (CAN_AUTOSTART) items.push({ label: "Start at login", type: "checkbox", checked: !!settings.startWithWindows, click: (item) => saveSettings({ startWithWindows: item.checked }) });
  items.push({ type: "separator" }, { label: "Quit", click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---- IPC -------------------------------------------------------------------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
  });
}

function assertAllowed() {
  if (!pre) throw new Error("Still checking the Claude CLI, try again in a moment.");
  if (!pre.claude.found) throw new Error("Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code, or set its path in Settings.");
  if (!pre.auth.loggedIn) throw new Error("Not logged in. Run the claude command once in a terminal and sign in with your Claude account.");
  if (settings.requireMax && pre.planKnown && !pre.isMax) {
    throw new Error(`Claude Max is required to run parallel sessions (detected plan: ${pre.plan}). You can turn this check off in Settings.`);
  }
}

function registerIpc() {
  handle("preflight", async (force) => (force || !pre) ? refreshPreflight() : pre);
  handle("settings:get", () => settings);
  handle("settings:set", async (next) => { saveSettings(next); await refreshPreflight(); return { settings, pre }; });
  handle("sessions:list", () => manager.list().map((s) => manager.public(s)));
  handle("sessions:create", async (opts) => { assertAllowed(); return manager.create(opts); });
  handle("sessions:remove", (id, opts) => manager.remove(id, opts || {}));
  handle("sessions:send", (id, prompt) => { assertAllowed(); return manager.send(id, prompt); });
  handle("sessions:stop", (id) => manager.stop(id));
  handle("sessions:stopAll", () => manager.stopAll());
  handle("sessions:events", (id) => manager.recentEvents(id));
  handle("names:random", () => randomName());
  handle("commander:get", () => { const c = manager.commander(); return c ? manager.public(c) : null; });
  handle("commander:setup", async (folder) => {
    if (!folder || !fs.existsSync(folder)) throw new Error("Folder does not exist: " + folder);
    let c = manager.commander();
    if (c) { c.cwd = folder; manager.save(); manager.emit("update", manager.public(c)); return manager.public(c); }
    return manager.create({ name: "commander", cwd: folder, permissionMode: "default", role: "commander" });
  });
  handle("commander:send", (prompt) => {
    assertAllowed();
    const c = manager.commander();
    if (!c) throw new Error("Choose a workspace folder for the commander first.");
    return manager.send(c.id, prompt);
  });
  handle("shell:openPath", (p) => shell.openPath(p));
  handle("dialog:pickFolder", async () => {
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], title: "Choose the folder this session works in" });
    return r.canceled ? null : r.filePaths[0];
  });
}
