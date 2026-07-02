const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sphereOverlay", {
  getWorkArea: () => ipcRenderer.invoke("sphere:getWorkArea"),
  moveTo: (x, y, animateMs) => ipcRenderer.send("sphere:moveTo", x, y, animateMs),
  moveBy: (dx, dy) => ipcRenderer.send("sphere:moveBy", dx, dy),
  setPosition: (x, y) => ipcRenderer.send("sphere:setPosition", x, y),
  getPosition: () => ipcRenderer.invoke("sphere:getPosition"),
  setIgnoreMouseEvents: (ignore, forward) =>
    ipcRenderer.send("sphere:setIgnoreMouseEvents", ignore, forward),
  setMenuExpanded: (expanded) => ipcRenderer.send("sphere:setMenuExpanded", !!expanded),
  setScheduleCollapsed: (collapsed) =>
    ipcRenderer.send("sphere:setScheduleCollapsed", !!collapsed),
  onPatch: (cb) => {
    ipcRenderer.on("sphere-overlay:patch", (_event, patch) => cb(patch));
  },
  onRoam: (cb) => {
    ipcRenderer.on("sphere-overlay:roam", () => cb());
  },
});
