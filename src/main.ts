import { init, Terminal, FitAddon } from 'ghostty-web';
import './style.css';
import { ReceivedNewlines } from './received-newlines.mts';

type Port = { path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string };
type Status = { connected: boolean; error?: string; path?: string };
type SerialAPI = { list(): Promise<Port[]>; connect(options: { path: string; baudRate: number }): Promise<void>; disconnect(): Promise<void>; write(data: string): Promise<void>; save(text: string): Promise<boolean>; copy(text: string): Promise<void>; onData(callback: (data: Uint8Array) => void): () => void; onStatus(callback: (status: Status) => void): () => void };
declare global { interface Window { serial?: SerialAPI } }
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header><span class="brand">soothe<span class="brand-dot"></span></span><span class="title-sub">SERIAL CONSOLE</span><span class="header-right">USB to a little more clarity.</span></header>
<div class="workspace"><aside><div class="section-heading">DEVICES <button id="refresh" class="icon-button" title="Refresh devices" aria-label="Refresh devices">↻</button></div><div id="devices"></div>
<button id="demo" class="demo-button"><span>◇</span> Try a demo console <span>↗</span></button>
<div class="settings"><div class="section-heading">CONNECTION</div><label for="baud">Baud rate</label><select id="baud"><option>9600</option><option>19200</option><option>38400</option><option>57600</option><option selected>115200</option><option>230400</option><option>460800</option><option>921600</option><option>1500000</option></select><div class="specs"><span>8 data bits</span><span>No parity</span><span>1 stop bit</span><span>No flow control</span></div><button id="connect" class="primary" disabled>Connect to device</button></div>
<div class="sidebar-foot"><span class="tiny-dot"></span> Made for the things you make.<small>Terminal powered by Ghostty</small></div></aside>
<main><div class="console-heading"><div><div class="eyebrow">WORKSPACE / CONSOLE</div><h1 id="device-title">Your next connection.</h1><p id="device-subtitle">A quiet place to listen to your hardware.</p></div><span id="badge" class="badge">Disconnected</span></div>
<div id="notice" role="status" hidden></div>
<section class="console-panel"><div class="console-toolbar"><span><i id="status-dot"></i> <span id="port-label">No device connected</span></span><div><button id="clear">Clear</button><button id="copy">Copy log</button><button id="save">Save log ↗</button></div></div><div class="terminal-wrap"><div id="terminal"></div><div id="empty"><div class="chip">⌘</div><h2>Small device. Open conversation.</h2><p>Plug in your Atom with a USB data cable,<br>choose its port, and connect.</p><span>115200 baud <b>·</b> 8N1 <b>·</b> Ready when you are</span></div></div><form id="command-form"><span class="prompt">›</span><input id="command" aria-label="Command to send" placeholder="Send a command to your device…" autocomplete="off" disabled><select id="ending" aria-label="Line ending"><option value="crlf">CR + LF</option><option value="lf">LF</option><option value="cr">CR</option><option value="none">None</option></select><button id="send" type="submit" disabled>Send ↵</button></form></section>
<footer><span id="activity">Waiting for a connection</span><span id="bytes">RX 0 B <b> / </b> TX 0 B</span><span>UTF-8 <b>·</b> GHOSTTY</span></footer></main></div>`;
let selected = '', connected = false, demo = false, busy = false, rx = 0, tx = 0;
let log = '', decoder = new TextDecoder();
let term: Terminal;
const receivedNewlines = new ReceivedNewlines();
let demoTimer: ReturnType<typeof setInterval> | undefined;
const api = window.serial;
function notice(message: string) { $('notice').textContent = message; $('notice').hidden = !message; }
function count() { $('bytes').textContent = `RX ${rx.toLocaleString()} B  /  TX ${tx.toLocaleString()} B`; }
function append(data: Uint8Array) { term.write(receivedNewlines.transform(data)); rx += data.byteLength; log = (log + decoder.decode(data, { stream: true })).slice(-4 * 1024 * 1024); count(); }
function renderState() {
  document.querySelectorAll<HTMLButtonElement>('.device').forEach(button => { button.disabled = connected || busy; });
  $('badge').textContent = demo ? 'Demo session' : connected ? 'Connected' : 'Disconnected';
  $('badge').classList.toggle('live', connected);
  $('status-dot').classList.toggle('live', connected);
  $('empty').hidden = connected || rx > 0;
  $('connect').textContent = busy ? 'Please wait…' : connected ? 'Disconnect' : 'Connect to device';
  ($('connect') as HTMLButtonElement).disabled = busy || (!connected && (!selected || !api));
  ($('baud') as HTMLSelectElement).disabled = connected || busy;
  ($('command') as HTMLInputElement).disabled = !connected || busy;
  ($('send') as HTMLButtonElement).disabled = !connected || busy;
  ($('demo') as HTMLButtonElement).disabled = connected || busy;
  $('port-label').textContent = demo ? 'demo://atom • simulated output' : connected ? selected : 'No device connected';
  $('activity').textContent = connected ? demo ? 'Simulated device session' : 'Receiving serial data' : 'Waiting for a connection';
}
async function refresh() {
  if (!api) { $('devices').textContent = 'Open the desktop app to discover USB devices.'; return; }
  try {
    const ports = (await api.list()).sort((a, b) => Number(Boolean(b.vendorId)) - Number(Boolean(a.vendorId)) || a.path.localeCompare(b.path));
    if (!connected && !ports.some(p => p.path === selected)) selected = ports.find(p => /usb|acm/i.test(p.path))?.path || ports[0]?.path || '';
    $('devices').replaceChildren();
    if (!ports.length) { const p = document.createElement('p'); p.className = 'no-devices'; p.textContent = 'No serial devices found. Plug in a USB data cable, then refresh.'; $('devices').append(p); }
    for (const port of ports) {
      const button = document.createElement('button'); button.className = `device ${selected === port.path ? 'selected' : ''}`;
      button.disabled = connected || busy;
      const name = document.createElement('strong'); name.textContent = port.manufacturer || (/usb/i.test(port.path) ? 'USB serial device' : 'Serial device');
      const path = document.createElement('small'); path.textContent = port.path;
      button.append(name, path); button.onclick = () => { selected = port.path; $('device-title').textContent = name.textContent; $('device-subtitle').textContent = port.path; void refresh(); }; $('devices').append(button);
    }
    renderState();
  } catch (error) { notice(String(error)); }
}
async function send(data: string) {
  try { if (!connected) return; if (demo) append(new TextEncoder().encode(`\r\n\x1b[36m[demo]\x1b[0m received: ${data}\r\n`)); else await api!.write(data); tx += new TextEncoder().encode(data).length; count(); }
  catch (error) { notice(String(error)); }
}
$('refresh').onclick = () => void refresh();
$('connect').onclick = async () => {
  busy = true; renderState(); notice('');
  try {
    if (connected) { if (demo) { clearInterval(demoTimer); demo = false; } else await api!.disconnect(); connected = false; }
    else {
      term.reset(); rx = tx = 0; log = ''; decoder = new TextDecoder(); receivedNewlines.reset(); count();
      await api!.connect({ path: selected, baudRate: Number(($('baud') as HTMLSelectElement).value) }); connected = true;
      $('device-title').textContent = 'Device console'; $('device-subtitle').textContent = selected; term.focus();
    }
  } catch (error) { notice(String(error)); }
  finally { busy = false; renderState(); void refresh(); }
};
$('clear').onclick = () => { term.clear(); };
$('copy').onclick = async () => { try { if (!log) return notice('No received data to copy yet.'); if (!api) return notice('Copying logs is available in the desktop app.'); await api.copy(log); notice('Console log copied to clipboard.'); } catch (error) { notice(String(error)); } };
$('save').onclick = async () => { try { if (!log) return notice('No received data to save yet.'); if (!api) return notice('Saving logs is available in the desktop app.'); if (await api.save(log)) notice('Console log saved.'); } catch (error) { notice(String(error)); } };
$('command-form').onsubmit = event => { event.preventDefault(); const input = $('command') as HTMLInputElement; const ending = ({ crlf: '\r\n', lf: '\n', cr: '\r', none: '' })[($('ending') as HTMLSelectElement).value] || ''; void send(input.value + ending); input.value = ''; };
$('demo').onclick = () => {
  demo = connected = true; rx = tx = 0; log = ''; decoder = new TextDecoder(); receivedNewlines.reset(); term.reset(); notice('Demo mode. This output is simulated; no USB device is connected.');
  $('device-title').textContent = 'Hello, Atom.'; $('device-subtitle').textContent = 'A preview of your next serial session.'; renderState();
  append(new TextEncoder().encode('\x1b[90mSoothe demo console • simulated M5Stack Atom\x1b[0m\r\n\r\nESP32 boot complete\r\n\x1b[32m[ok]\x1b[0m Serial console ready at 115200 baud\r\n\x1b[32m[ok]\x1b[0m RGB LED initialized\r\n\x1b[36m[info]\x1b[0m Type below, or click the terminal to send input.\r\n\r\n'));
  let tick = 0; demoTimer = setInterval(() => append(new TextEncoder().encode(`\x1b[90m${new Date().toLocaleTimeString()}\x1b[0m  heartbeat=${++tick}  status=\x1b[32mready\x1b[0m\r\n`)), 2500);
};
async function start() {
  await init();
  term = new Terminal({ fontFamily: 'Menlo, Monaco, monospace', fontSize: 13, cursorBlink: true, scrollback: 10000, theme: { background: '#10171b', foreground: '#c8d3d7', cursor: '#b9dba6', green: '#b9dba6', cyan: '#8bcbd3' } });
  const fit = new FitAddon(); term.loadAddon(fit); term.open($('terminal')); fit.fit(); fit.observeResize();
  term.onData(data => { void send(data); });
  api?.onData(data => append(new Uint8Array(data)));
  api?.onStatus(status => { connected = status.connected; if (status.error) notice(status.error); else if (!connected) notice('Serial connection closed. Reconnect when your device is ready.'); renderState(); });
  await refresh(); renderState();
}
start().catch(error => notice(`Could not start the terminal: ${error}`));
