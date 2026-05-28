const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sphereOverlay", {
  getWorkArea: () => ipcRenderer.invoke("sphere:getWorkArea"),
  moveTo: (x, y, animateMs) => ipcRenderer.send("sphere:moveTo", x, y, animateMs),
  moveBy: (dx, dy) => ipcRenderer.send("sphere:moveBy", dx, dy),
  setIgnoreMouseEvents: (ignore, forward) =>
    ipcRenderer.send("sphere:setIgnoreMouseEvents", ignore, forward),
  onPatch: (cb) => {
    ipcRenderer.on("sphere-overlay:patch", (_event, patch) => cb(patch));
  },
});
