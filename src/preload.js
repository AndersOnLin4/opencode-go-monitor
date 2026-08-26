const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("ocmon", {
  desktop: true,
  refreshNow: () => ipcRenderer.invoke("tick-now"),
  getData: () => ipcRenderer.invoke("get-data"),
  enterMini: () => ipcRenderer.invoke("enter-mini"),
  exitMini: () => ipcRenderer.invoke("exit-mini"),
  miniResize: (h) => ipcRenderer.invoke("mini-resize", h),
  addKey: (name, key) => ipcRenderer.invoke("add-key", name, key),
  removeKey: (name) => ipcRenderer.invoke("remove-key", name),
  setActiveAccount: (name) => ipcRenderer.invoke("set-active-account", name),
  getRemoteConfig: () => ipcRenderer.invoke("get-remote-config"),
  setRemoteConfig: (cfg) => ipcRenderer.invoke("set-remote-config", cfg),
  fetchRemote: () => ipcRenderer.invoke("fetch-remote"),
  getRemoteData: () => ipcRenderer.invoke("get-remote-data"),
  onRemoteProgress: (fn) => ipcRenderer.on("remote-progress", (_e, line) => fn(line)),
  onSync: (fn) => ipcRenderer.on("sync", (_e, payload) => fn(payload)),
})
