const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ConsoleSession } = require("../src/console-session.mts");
const bytes = (text) => new TextEncoder().encode(text);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const setup = (overrides = {}) => {
  const writes = [],
    notices = [],
    display = [];
  const observations = [];
  let resets = 0,
    changes = 0;
  const serial = {
    connect: async () => {},
    disconnect: async () => {},
    write: async (data) => {
      writes.push(data);
    },
    ...overrides,
  };
  const session = new ConsoleSession(serial, {
    changed: () => {
      changes++;
      observations.push({
        phase: session.phase,
        connected: session.connected,
        busy: session.busy,
        demo: session.demo,
        path: session.path,
        rx: session.rx,
        tx: session.tx,
        log: session.log,
      });
    },
    display: (data) => display.push(data),
    reset: () => {
      resets++;
    },
    notice: (message) => notices.push(message),
  });
  return {
    session,
    observations,
    writes,
    notices,
    display,
    get resets() {
      return resets;
    },
    get changes() {
      return changes;
    },
  };
};

test("pending connect owns its path, accepts early data, and blocks input and competing starts", async () => {
  const opening = deferred();
  const options = [];
  const h = setup({
    connect: (value) => {
      options.push(value);
      return opening.promise;
    },
  });
  const connecting = h.session.connect("/dev/a", 115200);
  assert.equal(h.session.phase, "connecting");
  assert.equal(h.session.busy, true);
  h.session.nativeStatus({ connected: true });
  await h.session.send("early");
  await h.session.connect("/dev/b", 9600);
  await h.session.disconnect();
  h.session.startDemo();
  h.session.nativeData(bytes("boot\n"));
  assert.equal(h.session.rx, 5);
  assert.equal(Buffer.concat(h.display).toString(), "boot\r\n");
  opening.resolve();
  await connecting;
  assert.equal(h.session.path, "/dev/a");
  assert.equal(h.session.phase, "connected");
  assert.equal(h.session.busy, false);
  assert.deepEqual(options, [{ path: "/dev/a", baudRate: 115200 }]);
  assert.deepEqual(h.writes, []);
  assert.equal(h.resets, 1);
  assert.ok(h.changes > 0);
});

test("close before connect completion cannot resurrect the connection", async () => {
  const opening = deferred();
  const h = setup({ connect: () => opening.promise });
  const connecting = h.session.connect("/dev/a", 115200);
  h.session.nativeStatus({ connected: true });
  h.session.nativeStatus({ connected: false });
  assert.equal(h.session.busy, true);
  opening.resolve();
  await connecting;
  assert.equal(h.session.phase, "disconnected");
  assert.match(h.notices.at(-1), /Serial connection closed/);
});

test("failed attempts reset old data and allow manual retry", async () => {
  let fail = false;
  const h = setup({
    connect: async () => {
      if (fail) {
        throw new Error("unplugged");
      }
    },
  });
  await h.session.connect("/dev/a", 115200);
  h.session.nativeData(bytes("old\r"));
  await h.session.send("é");
  assert.equal(h.session.tx, 2);
  await h.session.disconnect();
  assert.equal(h.session.log, "old\r");
  fail = true;
  await h.session.connect("/dev/a", 115200);
  assert.equal(h.session.phase, "disconnected");
  assert.equal(h.session.rx, 0);
  assert.equal(h.session.tx, 0);
  assert.equal(h.session.log, "");
  assert.match(h.notices.at(-1), /unplugged/);
  fail = false;
  await h.session.connect("/dev/a", 115200);
  h.session.nativeData(bytes("\nnew"));
  assert.equal(Buffer.from(h.display.at(-1)).toString(), "\r\nnew");
  assert.equal(h.resets, 3);
});

test("disconnect blocks input, preserves logs, and recovers from a failed close", async () => {
  const closing = deferred();
  const h = setup({ disconnect: () => closing.promise });
  await h.session.connect("/dev/a", 115200);
  h.session.nativeData(bytes("retained"));
  const disconnecting = h.session.disconnect();
  assert.equal(h.session.phase, "disconnecting");
  await h.session.send("blocked");
  await h.session.disconnect();
  assert.deepEqual(h.writes, []);
  closing.reject(new Error("close failed"));
  await disconnecting;
  assert.equal(h.session.phase, "connected");
  assert.equal(h.session.log, "retained");
  assert.match(h.notices.at(-1), /close failed/);
  await h.session.send("allowed");
  assert.deepEqual(h.writes, ["allowed"]);
});

test("a close event wins even if disconnect later rejects", async () => {
  const closing = deferred();
  const h = setup({ disconnect: () => closing.promise });
  await h.session.connect("/dev/a", 115200);
  const disconnecting = h.session.disconnect();
  h.session.nativeStatus({ connected: false });
  closing.reject(new Error("already closed"));
  await disconnecting;
  assert.equal(h.session.phase, "disconnected");
});

test("retired write completions and failures cannot change the next session", async () => {
  for (const failed of [false, true]) {
    const writing = deferred();
    const h = setup({ write: () => writing.promise });
    await h.session.connect("/dev/a", 115200);
    const pending = h.session.send("old");
    await h.session.disconnect();
    await h.session.connect("/dev/b", 9600);
    const noticeCount = h.notices.length;
    if (failed) {
      writing.reject(new Error("late failure"));
    } else {
      writing.resolve();
    }
    await pending;
    assert.equal(h.session.tx, 0);
    assert.equal(h.notices.length, noticeCount);
    assert.equal(h.session.path, "/dev/b");
  }
});

test("native errors keep an open session usable; unplug stops further input and data", async () => {
  const h = setup({
    write: async () => {
      throw new Error("write failed");
    },
  });
  await h.session.connect("/dev/a", 115200);
  h.session.nativeStatus({ connected: true, error: "warning" });
  assert.equal(h.session.connected, true);
  assert.equal(h.notices.at(-1), "warning");
  await h.session.send("no");
  assert.equal(h.session.tx, 0);
  assert.match(h.notices.at(-1), /write failed/);
  h.session.nativeStatus({ connected: false, error: "unplugged" });
  h.session.nativeData(bytes("late"));
  await h.session.send("late");
  assert.equal(h.session.rx, 0);
  assert.equal(h.session.connected, false);
  assert.equal(h.notices.at(-1), "unplugged");
});

test("demo ignores native events, retires its timer, and restarts with one heartbeat", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = setup();
  h.session.startDemo();
  const initialRx = h.session.rx;
  const demoNotice = h.notices.at(-1);
  h.session.nativeStatus({ connected: false, error: "old native error" });
  h.session.nativeData(bytes("old native data"));
  h.session.startDemo();
  assert.equal(h.session.demo, true);
  assert.equal(h.session.rx, initialRx);
  assert.equal(h.notices.at(-1), demoNotice);
  await h.session.send("hello");
  assert.equal(h.session.tx, 5);
  assert.match(h.session.log, /received: hello/);
  assert.deepEqual(h.writes, []);
  t.mock.timers.tick(2500);
  assert.match(h.session.log, /heartbeat=1/);
  await h.session.disconnect();
  const stoppedRx = h.session.rx;
  t.mock.timers.tick(5000);
  assert.equal(h.session.rx, stoppedRx);
  assert.equal(h.session.demo, false);
  h.session.startDemo();
  t.mock.timers.tick(2500);
  assert.equal((h.session.log.match(/heartbeat=/g) || []).length, 1);
  assert.equal(h.session.tx, 0);
  await h.session.disconnect();
});

test("browser demo works without native serial, and native attempt reports its absence", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const notices = [];
  const session = new ConsoleSession(undefined, {
    changed() {},
    display() {},
    reset() {},
    notice: (value) => notices.push(value),
  });
  await session.connect("/dev/a", 115200);
  assert.equal(session.phase, "disconnected");
  assert.match(notices.at(-1), /Open the desktop app/);
  session.startDemo();
  await session.send("hello");
  assert.equal(session.tx, 5);
  await session.disconnect();
});

test("observers see connection progress, received counters, send completion, and close completion", async () => {
  const opening = deferred(),
    closing = deferred(),
    writing = deferred();
  const h = setup({ connect: () => opening.promise, disconnect: () => closing.promise, write: () => writing.promise });
  assert.equal(h.session.path, "");
  const connecting = h.session.connect("/dev/a", 115200);
  assert.deepEqual(h.observations.at(-1), {
    phase: "connecting",
    connected: false,
    busy: true,
    demo: false,
    path: "/dev/a",
    rx: 0,
    tx: 0,
    log: "",
  });
  assert.equal(h.notices.at(-1), "");
  opening.resolve();
  await connecting;
  assert.equal(h.observations.at(-1).phase, "connected");
  h.session.nativeData(bytes("one"));
  assert.equal(h.observations.at(-1).rx, 3);
  assert.equal(h.observations.at(-1).log, "one");
  const sending = h.session.send("é");
  assert.equal(h.observations.at(-1).tx, 0);
  writing.resolve();
  await sending;
  assert.equal(h.observations.at(-1).tx, 2);
  h.session.nativeStatus({ connected: true });
  assert.equal(h.notices.at(-1), "");
  const disconnecting = h.session.disconnect();
  assert.equal(h.observations.at(-1).phase, "disconnecting");
  assert.equal(h.observations.at(-1).connected, true);
  assert.equal(h.observations.at(-1).busy, true);
  assert.equal(h.notices.at(-1), "");
  closing.resolve();
  await disconnecting;
  assert.equal(h.observations.at(-1).phase, "disconnected");
  assert.equal(h.observations.at(-1).connected, false);
  assert.equal(h.observations.at(-1).busy, false);
  assert.equal(h.observations.at(-1).log, "one");
});

test("observers recover controls after failed connection changes and unexpected close", async () => {
  const h = setup({
    connect: async () => {
      throw new Error("gone");
    },
  });
  await h.session.connect("/dev/a", 115200);
  assert.equal(h.observations.at(-1).phase, "disconnected");
  assert.equal(h.observations.at(-1).busy, false);
  const ready = setup({
    disconnect: async () => {
      throw new Error("busy");
    },
  });
  await ready.session.connect("/dev/a", 115200);
  await ready.session.disconnect();
  assert.equal(ready.observations.at(-1).phase, "connected");
  assert.equal(ready.observations.at(-1).busy, false);
  ready.session.nativeStatus({ connected: false });
  assert.equal(ready.observations.at(-1).phase, "disconnected");
});

test("demo publishes its identity and boot output, clears its notice on stop, and never closes native serial", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let nativeDisconnects = 0;
  const h = setup({
    disconnect: async () => {
      nativeDisconnects++;
    },
  });
  h.session.startDemo();
  assert.equal(h.session.path, "demo://atom • simulated output");
  assert.match(h.session.log, /ESP32 boot complete/);
  assert.equal(h.notices.at(-1), "Demo mode. This output is simulated; no USB device is connected.");
  const prior = h.observations.length;
  h.session.nativeStatus({ connected: true });
  assert.equal(h.observations.length, prior);
  assert.equal(h.notices.at(-1), "Demo mode. This output is simulated; no USB device is connected.");
  await h.session.disconnect();
  assert.equal(nativeDisconnects, 0);
  assert.equal(h.observations.at(-1).phase, "disconnected");
  assert.equal(h.notices.at(-1), "");
  const stopped = h.observations.length;
  t.mock.timers.tick(5000);
  assert.equal(h.observations.length, stopped);
});
