const { contextBridge, ipcRenderer } = require("electron");
const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (cb) => {
  const h = (_e, m) => cb(m);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};
contextBridge.exposeInMainWorld("swarm", {
  platform: process.platform,
  preflight: (force) => invoke("preflight", !!force),
  getSettings: () => invoke("settings:get"),
  setSettings: (s) => invoke("settings:set", s),
  listSessions: () => invoke("sessions:list"),
  createSession: (o) => invoke("sessions:create", o),
  removeSession: (id, o) => invoke("sessions:remove", id, o),
  send: (id, prompt) => invoke("sessions:send", id, prompt),
  stop: (id) => invoke("sessions:stop", id),
  stopAll: () => invoke("sessions:stopAll"),
  events: (id) => invoke("sessions:events", id),
  randomName: () => invoke("names:random"),
  commanderGet: () => invoke("commander:get"),
  commanderSetup: (folder) => invoke("commander:setup", folder),
  commanderSend: (prompt) => invoke("commander:send", prompt),
  pickFolder: () => invoke("dialog:pickFolder"),
  openPath: (p) => invoke("shell:openPath", p),
  onEvent: on("session:event"),
  onUpdate: on("session:update"),
  onRemoved: on("session:removed"),
  onPreflight: on("preflight"),
  onUiSettings: on("ui:settings"),
  onUiNewWorker: on("ui:new-worker"),
  onUiView: on("ui:view"),
});
