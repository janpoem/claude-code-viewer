import { type ChildProcess, execSync, fork } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";

const DEFAULT_PORT = 43199;

/**
 * When Electron launches as a .app on macOS (or from Start Menu on Windows),
 * process.env.PATH is minimal and doesn't include user-installed tools like
 * /opt/homebrew/bin (macOS) or npm global bin dirs.
 * This function resolves the full user shell PATH.
 */
function getFullPath(): string {
  // biome-ignore lint/style/noProcessEnv: need to read and fix PATH for packaged app
  const currentPath = process.env.PATH ?? "";

  if (process.platform === "win32") {
    return currentPath;
  }

  // macOS/Linux: get PATH from user's login shell
  try {
    // biome-ignore lint/style/noProcessEnv: need to detect user shell
    const userShell = process.env.SHELL ?? "/bin/zsh";
    const shellPath = execSync(`${userShell} -ilc 'echo $PATH'`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (shellPath) return shellPath;
  } catch {
    // fallback
  }

  // Append common paths that might be missing
  const extraPaths = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    path.join(app.getPath("home"), ".local", "bin"),
    path.join(app.getPath("home"), ".nvm", "versions", "node"),
  ];

  const pathSet = new Set(currentPath.split(":"));
  for (const p of extraPaths) {
    if (!pathSet.has(p)) {
      pathSet.add(p);
    }
  }

  return [...pathSet].join(":");
}

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let serverPort: number | null = null;

function getConfiguredPort(): number {
  // 1. Command line arg: --port=XXXXX
  const portArgIndex = process.argv.findIndex((arg) =>
    arg.startsWith("--port"),
  );
  if (portArgIndex !== -1) {
    const portArg = process.argv[portArgIndex];
    const portValue = portArg.includes("=")
      ? portArg.split("=")[1]
      : process.argv[portArgIndex + 1];
    const parsed = Number(portValue);
    if (parsed > 0 && parsed < 65536) return parsed;
  }

  // biome-ignore lint/style/noProcessEnv: Electron main process needs direct env access
  const envPort = process.env.CCV_PORT;
  if (envPort) {
    const parsed = Number(envPort);
    if (parsed > 0 && parsed < 65536) return parsed;
  }

  // 3. Config file: ~/.claude-code-viewer/config.json
  try {
    const configPath = path.join(
      app.getPath("home"),
      ".claude-code-viewer",
      "config.json",
    );
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const parsed = Number(config.port);
      if (parsed > 0 && parsed < 65536) return parsed;
    }
  } catch {
    // ignore config read errors
  }

  return DEFAULT_PORT;
}

function tryListenOnPort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr !== null) {
        server.close(() => resolve(addr.port));
      } else {
        reject(new Error("Failed to get server address"));
      }
    });
    server.on("error", () => {
      // Port in use, find a random free port
      const fallback = net.createServer();
      fallback.listen(0, "127.0.0.1", () => {
        const addr = fallback.address();
        if (typeof addr === "object" && addr !== null) {
          fallback.close(() => resolve(addr.port));
        } else {
          reject(new Error("Failed to get fallback port"));
        }
      });
      fallback.on("error", reject);
    });
  });
}

function startBackendServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverScript = path.join(__dirname, "server.mjs");

    serverProcess = fork(
      serverScript,
      ["--port", String(port), "--hostname", "127.0.0.1"],
      {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: {
          // biome-ignore lint/style/noProcessEnv: need to pass full env to server
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          PATH: getFullPath(),
        },
      },
    );

    const onStdout = (data: Buffer) => {
      const msg = data.toString();
      console.log("[server]", msg.trim());
      if (msg.includes("Server is running on")) {
        resolve();
      }
    };

    serverProcess.stdout?.on("data", onStdout);
    serverProcess.stderr?.on("data", (data: Buffer) => {
      console.error("[server:err]", data.toString().trim());
    });

    serverProcess.on("error", (err) => {
      console.error("Failed to start server:", err);
      reject(err);
    });

    serverProcess.on("exit", (code) => {
      console.log(`Server process exited with code ${String(code)}`);
      serverProcess = null;
    });

    setTimeout(() => {
      reject(new Error("Server start timed out"));
    }, 15000);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: "Claude Code Viewer",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${String(serverPort)}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1")) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function setupAutoUpdater() {
  try {
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
      dialog
        .showMessageBox({
          type: "info",
          title: "Update Available",
          message: `A new version (${info.version}) is available. Download now?`,
          buttons: ["Download", "Later"],
        })
        .then((result) => {
          if (result.response === 0) {
            autoUpdater.downloadUpdate();
          }
        });
    });

    autoUpdater.on("update-downloaded", () => {
      dialog
        .showMessageBox({
          type: "info",
          title: "Update Ready",
          message:
            "Update downloaded. The application will restart to apply the update.",
          buttons: ["Restart Now", "Later"],
        })
        .then((result) => {
          if (result.response === 0) {
            autoUpdater.quitAndInstall();
          }
        });
    });

    autoUpdater.on("error", (err) => {
      console.error("Auto-updater error:", err);
    });

    autoUpdater.checkForUpdates();
  } catch (err) {
    console.error("Failed to initialize auto-updater:", err);
  }
}

app.whenReady().then(async () => {
  try {
    const desiredPort = getConfiguredPort();
    serverPort = await tryListenOnPort(desiredPort);
    if (serverPort !== desiredPort) {
      console.log(
        `Port ${String(desiredPort)} in use, using port ${String(serverPort)} instead`,
      );
    }
    console.log(`Starting server on port ${String(serverPort)}...`);
    await startBackendServer(serverPort);
    console.log("Server started successfully");
    createWindow();

    if (app.isPackaged) {
      setupAutoUpdater();
    }
  } catch (err) {
    console.error("Failed to start application:", err);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null && serverPort !== null) {
    createWindow();
  }
});

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
});
