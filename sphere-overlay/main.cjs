const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const WIDTH = 300;
const HEIGHT = 380;
let mainWindow = null;
let tray = null;

function readCommandArg(argv = process.argv) {
  const raw = argv.find((value) => typeof value === "string" && value.startsWith("--pai-command="));
  return raw ? raw.slice("--pai-command=".length) : "";
}

function overlayDistDir() {
  return path.resolve(__dirname, "../agent-sphere-avatar/dist");
}

function loadOverlayPage(win) {
  const distOverlay = path.join(overlayDistDir(), "overlay.html");
  const ws = process.env.PAI_WS_URL || "ws://127.0.0.1:3000/ws";
  const sessionId = process.env.PAI_SESSION_ID || "";
  const httpBase = (process.env.PAI_HTTP_BASE || "http://127.0.0.1:3000").replace(/\/$/, "");
  const query = new URLSearchParams({ ws });
  if (sessionId) query.set("sessionId", sessionId);

  if (process.env.PAI_OVERLAY_DEV_URL) {
    const url = new URL(process.env.PAI_OVERLAY_DEV_URL);
    url.searchParams.set("ws", ws);
    if (sessionId) url.searchParams.set("sessionId", sessionId);
    void win.loadURL(url.toString());
    return;
  }

  const serverUrl = `${httpBase}/chat/assets/avatar/overlay.html?${query.toString()}`;

  void win.loadURL(serverUrl).catch((err) => {
    console.warn("[sphere-overlay] HTTP load failed, fallback to dist:", err?.message || err);

    if (!fs.existsSync(distOverlay)) {
      console.error("[sphere-overlay] Missing build. Run: cd agent-sphere-avatar && npm run build");
      void win.loadURL(
        `data:text/html,<h2 style='font-family:sans-serif;padding:16px'>请先构建 agent-sphere-avatar<br>并确认后端 ${httpBase} 已启动</h2>`,
      );
      return;
    }

    void win.loadFile(distOverlay, {
      query: { ws, ...(sessionId ? { sessionId } : {}) },
    });
  });
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: Math.round(width - WIDTH - 24),
    y: Math.round(height - HEIGHT - 24),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === "media") {
      callback(true);
      return;
    }
    callback(false);
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  loadOverlayPage(mainWindow);

  mainWindow.once("ready-to-show", () => {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function animateMove(targetX, targetY, durationMs = 1200) {
  if (!mainWindow) return;
  const start = mainWindow.getBounds();
  const startAt = Date.now();

  const tick = () => {
    if (!mainWindow) return;
    const t = Math.min(1, (Date.now() - startAt) / durationMs);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const x = Math.round(start.x + (targetX - start.x) * ease);
    const y = Math.round(start.y + (targetY - start.y) * ease);
    mainWindow.setBounds({ x, y, width: WIDTH, height: HEIGHT });
    if (t < 1) setImmediate(tick);
  };
  tick();
}

function handleCommand(command) {
  if (!command) {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
    return;
  }

  if (command === "close") {
    app.quit();
    return;
  }

  if (command === "roam") {
    mainWindow?.webContents.send("sphere-overlay:roam");
    return;
  }

  if (command === "show") {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock({
  command: readCommandArg(),
});

if (!gotSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
  const command = additionalData?.command || readCommandArg(argv);
  handleCommand(command);
});

app.whenReady().then(() => {
  createWindow();

  const trayIcon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  );
  tray = new Tray(trayIcon);
  tray.setToolTip("Agent Sphere · 桌面悬浮");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示/隐藏",
        click: () => {
          if (!mainWindow) return;
          if (mainWindow.isVisible()) mainWindow.hide();
          else mainWindow.show();
        },
      },
      {
        label: "随机漫游",
        click: () => mainWindow?.webContents.send("sphere-overlay:roam"),
      },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]),
  );

  ipcMain.handle("sphere:getWorkArea", () => {
    return screen.getPrimaryDisplay().workArea;
  });

  ipcMain.on("sphere:moveTo", (_ev, x, y, durationMs) => {
    animateMove(x, y, durationMs || 1200);
  });

  ipcMain.on("sphere:moveBy", (_ev, dx, dy) => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    mainWindow.setBounds({ x: b.x + dx, y: b.y + dy, width: WIDTH, height: HEIGHT });
  });

  ipcMain.on("sphere:setIgnoreMouseEvents", (_ev, ignore, forward) => {
    mainWindow?.setIgnoreMouseEvents(!!ignore, { forward: !!forward });
  });

  const moodFile =
    process.env.PAI_MOOD_FILE || path.join(app.getPath("temp"), "pai-sphere-mood.json");
  let lastMoodRaw = "";
  setInterval(() => {
    if (!mainWindow || !fs.existsSync(moodFile)) return;
    try {
      const raw = fs.readFileSync(moodFile, "utf8");
      if (!raw || raw === lastMoodRaw) return;
      lastMoodRaw = raw;
      const patch = JSON.parse(raw);
      mainWindow.webContents.send("sphere-overlay:patch", patch);
    } catch {
      /* ignore malformed mood file */
    }
  }, 250);

  handleCommand(readCommandArg());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
