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
