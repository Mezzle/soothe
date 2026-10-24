const { EventEmitter } = require("node:events");

class SerialSession extends EventEmitter {
  constructor(Port) {
    super();
    this.Port = Port;
    this.port = null;
    this.busy = false;
  }
  async list() {
    return this.Port.list();
  }
  async connect(options) {
    if (this.busy || this.port) {
      throw new Error("Disconnect the current session first.");
    }
    const { path, baudRate } = options || {};
    if (typeof path !== "string" || !Number.isInteger(baudRate) || baudRate < 300 || baudRate > 3000000) {
      throw new Error("Choose a valid port and baud rate.");
    }
    this.busy = true;
    try {
      const ports = await this.list();
      if (!ports.some((p) => p.path === path)) {
        throw new Error("This port is no longer available. Refresh the device list.");
      }
      const port = new this.Port({
        path,
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        rtscts: false,
        autoOpen: false,
      });
      this.port = port;
      port.on("data", (data) => this.emit("data", new Uint8Array(data)));
      port.on("error", (error) => this.emit("status", { error: error.message, connected: port.isOpen }));
      port.on("close", () => {
        if (this.port === port) {
          this.port = null;
        }
        this.emit("status", { connected: false });
      });
      await new Promise((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())));
      this.emit("status", { connected: true, path, baudRate });
    } catch (error) {
      this.port = null;
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async disconnect() {
    if (this.busy) {
      throw new Error("A connection change is already in progress.");
    }
    const port = this.port;
    if (!port) {
      return;
    }
    this.busy = true;
    try {
      if (port.isOpen) {
        await new Promise((resolve, reject) => port.close((error) => (error ? reject(error) : resolve())));
      }
      // busy prevents another connection until this close completes.
      this.port = null;
    } finally {
      this.busy = false;
    }
  }
  async write(data) {
    if (typeof data !== "string" || Buffer.byteLength(data) > 65536) {
      throw new Error("Send at most 64 KB at a time.");
    }
    const port = this.port;
    if (!port?.isOpen) {
      throw new Error("Connect to a device before sending.");
    }
    await new Promise((resolve, reject) =>
      port.write(data, (error) => (error ? reject(error) : port.drain((error) => (error ? reject(error) : resolve())))),
    );
  }
}
module.exports = { SerialSession };
