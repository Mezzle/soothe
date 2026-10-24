import { FitAddon, init, Terminal } from "ghostty-web";
import "./style.css";
import { ConsoleSession } from "./console-session.mts";

type Port = { path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string };
type Status = { connected: boolean; error?: string; path?: string };
type SerialAPI = {
  list(): Promise<Port[]>;
  connect(options: { path: string; baudRate: number }): Promise<void>;
  disconnect(): Promise<void>;
  write(data: string): Promise<void>;
  save(text: string): Promise<boolean>;
  copy(text: string): Promise<void>;
  onData(callback: (data: Uint8Array) => void): () => void;
  onStatus(callback: (status: Status) => void): () => void;
};
declare global {
  interface Window {
    serial?: SerialAPI;
  }
}
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
};
$("app").innerHTML = `
<header><span class="brand">soothe<span class="brand-dot"></span></span><span class="title-sub">SERIAL CONSOLE</span><span class="header-right">USB to a little more clarity.</span></header>
<div class="workspace"><aside><div class="section-heading">DEVICES <button id="refresh" class="icon-button" title="Refresh devices" aria-label="Refresh devices">↻</button></div><div id="devices"></div>
<button id="demo" class="demo-button"><span>◇</span> Try a demo console <span>↗</span></button>
<div class="settings"><div class="section-heading">CONNECTION</div><label for="baud">Baud rate</label><select id="baud"><option>9600</option><option>19200</option><option>38400</option><option>57600</option><option selected>115200</option><option>230400</option><option>460800</option><option>921600</option><option>1500000</option></select><div class="specs"><span>8 data bits</span><span>No parity</span><span>1 stop bit</span><span>No flow control</span></div><button id="connect" class="primary" disabled>Connect to device</button></div>
<div class="sidebar-foot"><span class="tiny-dot"></span> Made for the things you make.<small>Terminal powered by Ghostty</small></div></aside>
<main><div class="console-heading"><div><div class="eyebrow">WORKSPACE / CONSOLE</div><h1 id="device-title">Your next connection.</h1><p id="device-subtitle">A quiet place to listen to your hardware.</p></div><span id="badge" class="badge">Disconnected</span></div>
<div id="notice" role="status" hidden></div>
<section class="console-panel"><div class="console-toolbar"><span><i id="status-dot"></i> <span id="port-label">No device connected</span></span><div><button id="clear">Clear</button><button id="copy">Copy log</button><button id="save">Save log ↗</button></div></div><div class="terminal-wrap"><div id="terminal"></div><div id="empty"><div class="chip">⌘</div><h2>Small device. Open conversation.</h2><p>Plug in your Atom with a USB data cable,<br>choose its port, and connect.</p><span>115200 baud <b>·</b> 8N1 <b>·</b> Ready when you are</span></div></div><form id="command-form"><span class="prompt">›</span><input id="command" aria-label="Command to send" placeholder="Send a command to your device…" autocomplete="off" disabled><select id="ending" aria-label="Line ending"><option value="crlf">CR + LF</option><option value="lf">LF</option><option value="cr">CR</option><option value="none">None</option></select><button id="send" type="submit" disabled>Send ↵</button></form></section>
<footer><span id="activity">Waiting for a connection</span><span id="bytes">RX 0 B <b> / </b> TX 0 B</span><span>UTF-8 <b>·</b> GHOSTTY</span></footer></main></div>`;
let selected = "";
let term: Terminal;
const api = window.serial;
const notice = (message: string) => {
  $("notice").textContent = message;
  $("notice").hidden = !message;
};
let renderedPhase = "";
let renderedHasData = false;
const session = new ConsoleSession(api, {
  changed: () => {
    const hasData = session.rx > 0;
    if (session.phase === renderedPhase && hasData === renderedHasData) {
      count();
    } else {
      renderState();
    }
  },
  display: (data) => term.write(data),
  reset: () => term.reset(),
  notice,
});
const count = () => {
  $("bytes").textContent = `RX ${session.rx.toLocaleString()} B  /  TX ${session.tx.toLocaleString()} B`;
};
const renderStatus = () => {
  let badge = "Disconnected";
  let port = "No device connected";
  let activity = "Waiting for a connection";
  if (session.connected) {
    badge = "Connected";
    port = session.path;
    activity = "Receiving serial data";
  }
  if (session.demo) {
    badge = "Demo session";
    port = "demo://atom • simulated output";
    activity = "Simulated device session";
  }
  $("badge").textContent = badge;
  $("port-label").textContent = port;
  $("activity").textContent = activity;
  $("badge").classList.toggle("live", session.connected);
  $("status-dot").classList.toggle("live", session.connected);
  $("empty").hidden = session.connected || session.rx > 0;
};
const renderState = () => {
  renderedPhase = session.phase;
  renderedHasData = session.rx > 0;
  count();
  const settingsDisabled = session.connected || session.busy;
  const inputDisabled = !session.connected || session.busy;
  document.querySelectorAll<HTMLButtonElement>(".device").forEach((button) => {
    button.disabled = settingsDisabled;
  });
  const connectLabel = session.connected ? "Disconnect" : "Connect to device";
  $("connect").textContent = session.busy ? "Please wait…" : connectLabel;
  $("connect").toggleAttribute("disabled", session.busy || (!session.connected && (!selected || !api)));
  $("baud").toggleAttribute("disabled", settingsDisabled);
  $("demo").toggleAttribute("disabled", settingsDisabled);
  $("command").toggleAttribute("disabled", inputDisabled);
  $("send").toggleAttribute("disabled", inputDisabled);
  renderStatus();
};
const refresh = async () => {
  if (!api) {
    $("devices").textContent = "Open the desktop app to discover USB devices.";
    return;
  }
  try {
    const ports = (await api.list()).sort(
      (a, b) => Number(Boolean(b.vendorId)) - Number(Boolean(a.vendorId)) || a.path.localeCompare(b.path),
    );
    if (!session.connected && !session.busy && !ports.some((p) => p.path === selected)) {
      selected = ports.find((p) => /usb|acm/i.test(p.path))?.path || ports[0]?.path || "";
    }
    $("devices").replaceChildren();
    if (!ports.length) {
      const p = document.createElement("p");
      p.className = "no-devices";
      p.textContent = "No serial devices found. Plug in a USB data cable, then refresh.";
      $("devices").append(p);
    }
    for (const port of ports) {
      const button = document.createElement("button");
      button.className = `device ${selected === port.path ? "selected" : ""}`;
      button.disabled = session.connected || session.busy;
      const name = document.createElement("strong");
      name.textContent = port.manufacturer || (/usb/i.test(port.path) ? "USB serial device" : "Serial device");
      const path = document.createElement("small");
      path.textContent = port.path;
      button.append(name, path);
      button.onclick = () => {
        selected = port.path;
        $("device-title").textContent = name.textContent;
        $("device-subtitle").textContent = port.path;
        void refresh();
      };
      $("devices").append(button);
    }
    renderState();
  } catch (error) {
    notice(String(error));
  }
};
$("refresh").onclick = () => void refresh();
$("connect").onclick = async () => {
  if (session.connected) {
    await session.disconnect();
  } else {
    await session.connect(selected, Number(($("baud") as HTMLSelectElement).value));
    if (session.connected) {
      $("device-title").textContent = "Device console";
      $("device-subtitle").textContent = session.path;
      term.focus();
    }
  }
  void refresh();
};
$("clear").onclick = () => {
  term.clear();
};
$("copy").onclick = async () => {
  try {
    if (!session.log) {
      return notice("No received data to copy yet.");
    }
    if (!api) {
      return notice("Copying logs is available in the desktop app.");
    }
    await api.copy(session.log);
    notice("Console log copied to clipboard.");
  } catch (error) {
    notice(String(error));
  }
};
$("save").onclick = async () => {
  try {
    if (!session.log) {
      return notice("No received data to save yet.");
    }
    if (!api) {
      return notice("Saving logs is available in the desktop app.");
    }
    if (await api.save(session.log)) {
      notice("Console log saved.");
    }
  } catch (error) {
    notice(String(error));
  }
};
$("command-form").onsubmit = (event) => {
  event.preventDefault();
  const input = $("command") as HTMLInputElement;
  const ending = { crlf: "\r\n", lf: "\n", cr: "\r", none: "" }[($("ending") as HTMLSelectElement).value] || "";
  void session.send(input.value + ending);
  input.value = "";
};
$("demo").onclick = () => {
  session.startDemo();
  if (session.demo) {
    $("device-title").textContent = "Hello, Atom.";
    $("device-subtitle").textContent = "A preview of your next serial session.";
  }
};
const start = async () => {
  await init();
  term = new Terminal({
    fontFamily: "Menlo, Monaco, monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    theme: { background: "#10171b", foreground: "#c8d3d7", cursor: "#b9dba6", green: "#b9dba6", cyan: "#8bcbd3" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open($("terminal"));
  fit.fit();
  fit.observeResize();
  term.onData((data) => {
    void session.send(data);
  });
  api?.onData((data) => session.nativeData(new Uint8Array(data)));
  api?.onStatus((status) => session.nativeStatus(status));
  await refresh();
  renderState();
};
start().catch((error) => notice(`Could not start the terminal: ${error}`));
