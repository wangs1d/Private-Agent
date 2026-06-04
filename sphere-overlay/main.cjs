const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require("electron");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { applyDeskPetShell } = require("./win32-desk-pet.cjs");

/** 3D 桌宠：左侧机器区 + 右侧菜单区（展开时） */
const PET_WIDTH = 100;
const PET_HEIGHT = 125;
const MENU_WIDTH = 136;
const WIDTH = PET_WIDTH;
const HEIGHT = PET_HEIGHT;
let menuExpanded = false;
let mainWindow = null;
let tray = null;
let staticServer = null;
let staticServerPort = 0;

const LOG_FILE = path.join(
  process.env.TEMP || process.env.TMP || __dirname,
  "pai-sphere-overlay.log",
);

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* ignore */
  }
  console.log(...args);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".obj": "text/plain; charset=utf-8",
};

function readCommandArg(argv = process.argv) {
  const raw = argv.find((value) => typeof value === "string" && value.startsWith("--pai-command="));
  return raw ? raw.slice("--pai-command=".length) : "";
}

function overlayDistDir() {
  return path.resolve(__dirname, "../agent-sphere-avatar/dist");
}

function ensureStaticServer(rootDir) {
  return new Promise((resolve, reject) => {
    if (staticServer && staticServerPort > 0) {
      resolve(staticServerPort);
      return;
    }

    const normalizedRoot = path.resolve(rootDir);
    staticServer = http.createServer((req, res) => {
      try {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        if (!rel || rel.endsWith("/")) rel = `${rel}overlay.html`.replace(/^\/+/, "");

        const filePath = path.resolve(normalizedRoot, rel);
        if (!filePath.startsWith(normalizedRoot + path.sep) && filePath !== normalizedRoot) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }

        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          res.writeHead(404);
          res.end(`Not found: ${rel}`);
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        fs.createReadStream(filePath).pipe(res);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    });

    staticServer.on("error", reject);
    staticServer.listen(0, "127.0.0.1", () => {
      staticServerPort = staticServer.address().port;
      log(`static server http://127.0.0.1:${staticServerPort}/ root=${normalizedRoot}`);
      resolve(staticServerPort);
    });
  });
}

async function loadOverlayPage(win) {
  const distRoot = overlayDistDir();
  const distOverlay = path.join(distRoot, "overlay.html");
  const ws = process.env.PAI_WS_URL || "ws://127.0.0.1:3000/ws";
  const sessionId = process.env.PAI_SESSION_ID || "";
  const httpBase = (process.env.PAI_HTTP_BASE || "http://127.0.0.1:3000").replace(/\/$/, "");
  const query = new URLSearchParams({ ws });
  if (sessionId) query.set("sessionId", sessionId);
  query.set("petW", String(WIDTH));
  query.set("petH", String(HEIGHT));

  const showLoadError = (message) => {
    if (win.isDestroyed()) return;
    log("load error:", message);
    void win.loadURL(
      `data:text/html,<meta charset=utf-8><body style='font-family:sans-serif;padding:16px;color:#fff;background:#222'>`
        + `<h3>桌宠加载失败</h3><pre style='white-space:pre-wrap'>${message}</pre>`
        + `<p>请执行: cd agent-sphere-avatar && npm run build</p></body>`,
    );
  };

  win.webContents.on("did-fail-load", (_event, code, desc, validatedURL) => {
    log("did-fail-load", code, desc, validatedURL);
  });

  if (process.env.PAI_OVERLAY_DEV_URL) {
    const url = new URL(process.env.PAI_OVERLAY_DEV_URL);
    url.searchParams.set("ws", ws);
    if (sessionId) url.searchParams.set("sessionId", sessionId);
    await win.loadURL(url.toString());
    return;
  }

  if (fs.existsSync(distOverlay)) {
    try {
      const port = await ensureStaticServer(distRoot);
      const localUrl = `http://127.0.0.1:${port}/overlay.html?${query.toString()}`;
      log("loading", localUrl);
      await win.loadURL(localUrl);
      return;
    } catch (err) {
      showLoadError(`本地静态服务启动失败: ${err?.message || err}`);
      return;
    }
  }

  const serverUrl = `${httpBase}/chat/assets/avatar/overlay.html?${query.toString()}`;
  try {
    await win.loadURL(serverUrl);
  } catch (err) {
    showLoadError(
      `HTTP 加载失败: ${err?.message || err}\n`
        + `请确认后端 ${httpBase} 已启动，或执行 npm run build 生成本地 dist。`,
    );
  }
}

function finishDeskPetShow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  applyDeskPetShell(mainWindow);
  if (process.env.PAI_OVERLAY_OPAQUE !== "1") {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: Math.round(width - WIDTH - 24),
    y: Math.round(height - HEIGHT - 24),
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  if (process.env.PAI_OVERLAY_DEV === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  if (process.env.PAI_OVERLAY_OPAQUE === "1") {
    mainWindow.setBackgroundColor("#12141c");
  }

  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === "media") {
      callback(true);
      return;
    }
    callback(false);
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  void loadOverlayPage(mainWindow);

  mainWindow.once("ready-to-show", () => {
    if (typeof mainWindow.showInactive === "function") {
      mainWindow.showInactive();
    } else {
      mainWindow.show();
    }
    finishDeskPetShow();
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
    mainWindow.setBounds({ x, y, width: start.width, height: start.height });
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
      if (typeof mainWindow.showInactive === "function") {
        mainWindow.showInactive();
      } else {
        mainWindow.show();
      }
      finishDeskPetShow();
    }
  }
}

if (process.env.PAI_OVERLAY_DISABLE_GPU === "1") {
  app.disableHardwareAcceleration();
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
  tray.setToolTip("Agent 桌宠");
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

  ipcMain.on("sphere:setMenuExpanded", (_ev, expanded) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    menuExpanded = !!expanded;
    const b = mainWindow.getBounds();
    const width = menuExpanded ? PET_WIDTH + MENU_WIDTH : PET_WIDTH;
    mainWindow.setBounds({ x: b.x, y: b.y, width, height: PET_HEIGHT });
  });

  ipcMain.on("sphere:moveBy", (_ev, dx, dy) => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    mainWindow.setBounds({ x: b.x + dx, y: b.y + dy, width: b.width, height: b.height });
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

app.on("will-quit", () => {
  if (staticServer) {
    staticServer.close();
    staticServer = null;
    staticServerPort = 0;
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
