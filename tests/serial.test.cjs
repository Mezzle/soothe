const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { SerialSession } = require("../electron/serial.cjs");
class Port extends EventEmitter {
  static async list() {
    return [{ path: "/dev/test" }];
  }
  constructor(options) {
    super();
    this.options = options;
    this.isOpen = false;
  }
  open(cb) {
    setImmediate(() => {
      this.isOpen = true;
      cb();
    });
  }
  close(cb) {
    this.isOpen = false;
    this.emit("close");
    cb();
  }
  write(data, cb) {
    this.lastWrite = data;
    cb();
  }
  drain(cb) {
    cb();
  }
}
test("connect, exact byte delivery, write, unplug and reconnect", async () => {
  const session = new SerialSession(Port);
  const received = [];
  const status = [];
  session.on("data", (data) => received.push(...data));
  session.on("status", (data) => status.push(data));
  await session.connect({ path: "/dev/test", baudRate: 115200 });
  session.port.emit("data", Buffer.from([0, 255, 27, 91]));
  assert.deepEqual(received, [0, 255, 27, 91]);
  await session.write("test\r\n");
  assert.equal(session.port.lastWrite, "test\r\n");
  session.port.isOpen = false;
  session.port.emit("close");
  await assert.rejects(session.write("x"), /Connect/);
  assert.equal(status.at(-1).connected, false);
  await session.connect({ path: "/dev/test", baudRate: 9600 });
  await session.disconnect();
  assert.equal(session.port, null);
});
test("reject invalid paths, rates, simultaneous opens, and oversized writes", async () => {
  const session = new SerialSession(Port);
  await assert.rejects(session.connect({ path: "/missing", baudRate: 115200 }), /no longer/);
  await assert.rejects(session.connect({ path: "/dev/test", baudRate: -1 }), /valid/);
  const opening = session.connect({ path: "/dev/test", baudRate: 115200 });
  await assert.rejects(session.connect({ path: "/dev/test", baudRate: 115200 }), /Disconnect/);
  await opening;
  await assert.rejects(session.write("x".repeat(65537)), /64 KB/);
  await session.disconnect();
});
test("failed open leaves session available for retry", async () => {
  class FailingPort extends Port {
    open(cb) {
      cb(new Error("Port busy"));
    }
  }
  const session = new SerialSession(FailingPort);
  await assert.rejects(session.connect({ path: "/dev/test", baudRate: 115200 }), /Port busy/);
  assert.equal(session.port, null);
  assert.equal(session.busy, false);
  session.Port = Port;
  await session.connect({ path: "/dev/test", baudRate: 115200 });
  await session.disconnect();
});

test("validates options and accepts inclusive baud limits with multiple available ports", async () => {
  class MultiplePorts extends Port {
    static async list() {
      return [{ path: "/dev/other" }, { path: "/dev/test" }];
    }
  }
  const session = new SerialSession(MultiplePorts);
  for (const options of [
    undefined,
    {},
    { path: 1, baudRate: 115200 },
    { path: "/dev/test", baudRate: 300.5 },
    { path: "/dev/test", baudRate: 299 },
    { path: "/dev/test", baudRate: 3000001 },
  ]) {
    await assert.rejects(session.connect(options), /Choose a valid port and baud rate/);
  }
  for (const baudRate of [300, 3000000]) {
    const statuses = [];
    session.on("status", (status) => statuses.push(status));
    await session.connect({ path: "/dev/test", baudRate });
    assert.deepEqual(session.port.options, {
      path: "/dev/test",
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      rtscts: false,
      autoOpen: false,
    });
    assert.deepEqual(statuses.at(-1), { connected: true, path: "/dev/test", baudRate });
    await session.disconnect();
  }
});

test("forwards device errors and ignores a stale port close after reconnect", async () => {
  const session = new SerialSession(Port);
  const statuses = [];
  session.on("status", (status) => statuses.push(status));
  await session.connect({ path: "/dev/test", baudRate: 115200 });
  const oldPort = session.port;
  oldPort.emit("error", new Error("USB read failed"));
  assert.deepEqual(statuses.at(-1), { error: "USB read failed", connected: true });
  await session.disconnect();
  await session.connect({ path: "/dev/test", baudRate: 115200 });
  const newPort = session.port;
  oldPort.emit("close");
  assert.equal(session.port, newPort);
  await session.disconnect();
});

test("disconnect is idle-safe, blocks concurrent changes and waits for close", async () => {
  class DelayedClose extends Port {
    close(callback) {
      this.finishClose = () => {
        this.isOpen = false;
        callback();
      };
    }
  }
  const session = new SerialSession(DelayedClose);
  await session.disconnect();
  const opening = session.connect({ path: "/dev/test", baudRate: 115200 });
  await assert.rejects(session.disconnect(), /A connection change is already in progress/);
  await opening;
  const port = session.port;
  const closing = session.disconnect();
  assert.equal(session.busy, true);
  await assert.rejects(session.connect({ path: "/dev/test", baudRate: 115200 }), /Disconnect/);
  await assert.rejects(session.disconnect(), /A connection change is already in progress/);
  port.finishClose();
  await closing;
  assert.equal(port.isOpen, false);
  assert.equal(session.port, null);
  assert.equal(session.busy, false);
  await session.disconnect();
});

test("disconnect releases an already closed port without closing it again", async () => {
  class ClosedPort extends Port {
    close() {
      assert.fail("Cannot close an already closed port");
    }
  }
  const session = new SerialSession(ClosedPort);
  await session.connect({ path: "/dev/test", baudRate: 115200 });
  session.port.isOpen = false;
  await session.disconnect();
  assert.equal(session.port, null);
  assert.equal(session.busy, false);
});

test("failed close releases busy state and retains the port for retry", async () => {
  class FailedClose extends Port {
    close(cb) {
      cb(new Error("close failed"));
    }
  }
  const session = new SerialSession(FailedClose);
  await session.connect({ path: "/dev/test", baudRate: 115200 });
  const port = session.port;
  await assert.rejects(session.disconnect(), /close failed/);
  assert.equal(session.busy, false);
  assert.equal(session.port, port);
});

test("write limits use UTF-8 bytes and successful writes wait for drain", async () => {
  class DrainingPort extends Port {
    drain(cb) {
      this.finishDrain = cb;
    }
  }
  const session = new SerialSession(DrainingPort);
  await session.connect({ path: "/dev/test", baudRate: 115200 });
  await assert.rejects(session.write(123), /Send at most 64 KB/);
  await assert.rejects(session.write("é".repeat(32769)), /Send at most 64 KB/);
  let finished = false;
  const write = session.write("é".repeat(32768)).then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  session.port.finishDrain();
  await write;
  assert.equal(finished, true);
  await session.disconnect();
});

test("write and drain errors reach the caller", async () => {
  class WriteError extends Port {
    write(_data, cb) {
      cb(new Error("write failed"));
    }
  }
  class DrainError extends Port {
    drain(cb) {
      cb(new Error("drain failed"));
    }
  }
  for (const [PortType, message] of [
    [WriteError, /write failed/],
    [DrainError, /drain failed/],
  ]) {
    const session = new SerialSession(PortType);
    await session.connect({ path: "/dev/test", baudRate: 115200 });
    await assert.rejects(session.write("test"), message);
    await session.disconnect();
  }
});

test("retired ports cannot publish bytes, errors, or status into a new connection", async () => {
  const session = new SerialSession(Port);
  const statuses = [];
  const received = [];
  session.on("status", (status) => statuses.push(status));
  session.on("data", (data) => received.push(...data));
  await session.connect({ path: "/dev/test", baudRate: 115200 });
  const oldPort = session.port;
  await session.disconnect();
  await session.connect({ path: "/dev/test", baudRate: 9600 });
  const expected = [...statuses];
  oldPort.emit("close");
  oldPort.emit("error", new Error("retired device failed"));
  oldPort.emit("data", Buffer.from([42]));
  assert.deepEqual(statuses, expected);
  assert.deepEqual(received, []);
  assert.equal(session.port.isOpen, true);
  await session.disconnect();
});

test("failed-open ports cannot publish events after retry", async () => {
  let failedPort;
  class FailsOpen extends Port {
    open(callback) {
      failedPort = this;
      callback(new Error("open failed"));
    }
  }
  const session = new SerialSession(FailsOpen);
  const statuses = [];
  const received = [];
  session.on("status", (status) => statuses.push(status));
  session.on("data", (data) => received.push(...data));
  await assert.rejects(session.connect({ path: "/dev/test", baudRate: 115200 }), /open failed/);
  session.Port = Port;
  await session.connect({ path: "/dev/test", baudRate: 9600 });
  const expected = [...statuses];
  failedPort.emit("error", new Error("late open error"));
  failedPort.emit("data", Buffer.from([42]));
  failedPort.emit("close");
  assert.deepEqual(statuses, expected);
  assert.deepEqual(received, []);
  await session.disconnect();
});

test("close before the open callback never publishes a successful connection", async () => {
  class ClosesDuringOpen extends Port {
    open(callback) {
      this.emit("close");
      callback();
    }
  }
  const session = new SerialSession(ClosesDuringOpen);
  const statuses = [];
  session.on("status", (status) => statuses.push(status));
  await assert.rejects(session.connect({ path: "/dev/test", baudRate: 115200 }), /closed before opening completed/);
  assert.deepEqual(statuses, [{ connected: false }]);
  assert.equal(session.port, null);
  assert.equal(session.busy, false);
});

test("shutdown waits for discovery and blocks new opens until cleanup finishes", async () => {
  let finishDiscovery;
  let port;
  class DiscoveringPort extends Port {
    constructor(options) {
      super(options);
      port = this;
    }
    static list() {
      return new Promise((resolve) => {
        finishDiscovery = () => resolve([{ path: "/dev/test" }]);
      });
    }
  }
  const session = new SerialSession(DiscoveringPort);
  const opening = session.connect({ path: "/dev/test", baudRate: 115200 });
  const shutdown = session.shutdown();
  assert.equal(session.shutdown(), shutdown);
  let finished = false;
  void shutdown.then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  finishDiscovery();
  await opening;
  await assert.rejects(session.connect({ path: "/dev/test", baudRate: 115200 }), /Disconnect/);
  await shutdown;
  assert.equal(port.isOpen, false);
  assert.equal(session.port, null);
  assert.equal(session.busy, false);
  session.Port = Port;
  await session.connect({ path: "/dev/test", baudRate: 115200 });
  await session.disconnect();
});

test("shutdown waits for an open callback even after an unrelated error event", async () => {
  let port;
  class OpeningPort extends Port {
    open(callback) {
      port = this;
      this.finishOpen = () => {
        this.isOpen = true;
        callback();
      };
    }
  }
  const session = new SerialSession(OpeningPort);
  const opening = session.connect({ path: "/dev/test", baudRate: 115200 });
  await new Promise((resolve) => setImmediate(resolve));
  const shutdown = session.shutdown();
  port.emit("error", new Error("stream error"));
  assert.equal(session.busy, true);
  assert.equal(session.port, port);
  port.finishOpen();
  await opening;
  await shutdown;
  assert.equal(port.isOpen, false);
  assert.equal(session.port, null);
});

test("shutdown waits for a pending close callback and reports close failure for retry", async () => {
  class ClosingPort extends Port {
    close(callback) {
      this.finishClose = (error) => {
        if (!error) {
          this.isOpen = false;
          this.emit("close");
        }
        callback(error);
      };
    }
  }
  const session = new SerialSession(ClosingPort);
  await session.connect({ path: "/dev/test", baudRate: 115200 });
  const port = session.port;
  const closing = session.disconnect();
  const shutdown = session.shutdown();
  port.finishClose();
  await closing;
  await shutdown;
  assert.equal(session.port, null);
  await session.connect({ path: "/dev/test", baudRate: 115200 });
  const retryPort = session.port;
  const failingShutdown = session.shutdown();
  await Promise.resolve();
  retryPort.finishClose(new Error("close failed"));
  await assert.rejects(failingShutdown, /close failed/);
  assert.equal(session.port, retryPort);
  assert.equal(session.busy, false);
  const retry = session.shutdown();
  await Promise.resolve();
  retryPort.finishClose();
  await retry;
  assert.equal(session.port, null);
});

test("shutdown of an idle session briefly excludes connections and is reusable", async () => {
  const session = new SerialSession(Port);
  const shutdown = session.shutdown();
  await assert.rejects(session.connect({ path: "/dev/test", baudRate: 115200 }), /Disconnect/);
  await shutdown;
  await session.shutdown();
  await session.connect({ path: "/dev/test", baudRate: 115200 });
  await session.shutdown();
  assert.equal(session.port, null);
});

test("shutdown finishes after failed discovery or opening", async () => {
  class FailedDiscovery extends Port {
    static async list() {
      throw new Error("discovery failed");
    }
  }
  class FailedOpening extends Port {
    open(callback) {
      callback(new Error("opening failed"));
    }
  }
  for (const Adapter of [FailedDiscovery, FailedOpening]) {
    const session = new SerialSession(Adapter);
    const opening = session.connect({ path: "/dev/test", baudRate: 115200 });
    const shutdown = session.shutdown();
    await assert.rejects(opening, /failed/);
    await shutdown;
    assert.equal(session.port, null);
    assert.equal(session.busy, false);
  }
});
