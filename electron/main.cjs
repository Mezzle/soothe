const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard } = require("electron");
const { SerialPort } = require("serialport");
const { SerialSession } = require("./serial.cjs");
const path = require("node:path");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
class MacSerialPort extends SerialPort {
  static async list() {
    const ports = await SerialPort.list();
    return Promise.all(
      ports.map(async (port) => {
        if (process.platform !== "darwin" || !port.path.startsWith("/dev/tty.")) {
          return port;
        }
        const callout = port.path.replace("/dev/tty.", "/dev/cu.");
        try {
          await fs.access(callout);
          return { ...port, path: callout };
        } catch {
          return port;
        }
      }),
    );
  }
}
const session = new SerialSession(MacSerialPort);
let window;
const page = pathToFileURL(path.join(__dirname, "../dist/index.html")).href;
const send = (channel, data) => {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, data);
  }
};
session.on("data", (data) => send("serial:data", data));
session.on("status", (data) => send("serial:status", data));
const handle = (name, fn) => {
  ipcMain.handle(name, async (event, ...args) => {
    if (
      event.sender !== window?.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== page
    ) {
      throw new Error("Untrusted request");
    }
    return fn(...args);
  });
};
handle("serial:list", () => session.list());
handle("serial:connect", (options) => session.connect(options));
handle("serial:disconnect", () => session.disconnect());
handle("serial:write", (data) => session.write(data));
handle("serial:copy", async (text) => {
  if (typeof text !== "string" || text.length > 8 * 1024 * 1024) {
    throw new Error("Log is too large.");
  }
  await clipboard.writeText(text);
});
handle("serial:save", async (text) => {
  if (typeof text !== "string" || text.length > 8 * 1024 * 1024) {
    throw new Error("Log is too large.");
  }
  const result = await dialog.showSaveDialog(window, {
    defaultPath: `soothe-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
    filters: [{ name: "Console log", extensions: ["log", "txt"] }],
  });
  if (result.canceled) {
    return false;
  }
  await fs.writeFile(result.filePath, text, "utf8");
  return true;
});
const createWindow = () => {
  window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 880,
    minHeight: 600,
    title: "Soothe",
    backgroundColor: "#10171b",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 22 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("closed", () => {
    void session.shutdown().catch((error) => console.error("Could not release the serial device:", error));
  });
  window.loadURL(page);
};
app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "Soothe", submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
  createWindow();
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) {
      createWindow();
    }
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
