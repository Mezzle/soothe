const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SerialSession } = require('../electron/serial.cjs');
class Port extends EventEmitter {
  static async list() { return [{ path: '/dev/test' }]; }
  constructor(options) { super(); this.options = options; this.isOpen = false; }
  open(cb) { setImmediate(() => { this.isOpen = true; cb(); }); }
  close(cb) { this.isOpen = false; this.emit('close'); cb(); }
  write(data, cb) { this.lastWrite = data; cb(); }
  drain(cb) { cb(); }
}
test('connect, exact byte delivery, write, unplug and reconnect', async () => {
  const session = new SerialSession(Port); const received = []; const status = [];
  session.on('data', data => received.push(...data)); session.on('status', data => status.push(data));
  await session.connect({ path: '/dev/test', baudRate: 115200 });
  session.port.emit('data', Buffer.from([0, 255, 27, 91]));
  assert.deepEqual(received, [0, 255, 27, 91]);
  await session.write('test\r\n'); assert.equal(session.port.lastWrite, 'test\r\n');
  session.port.isOpen = false; session.port.emit('close');
  await assert.rejects(session.write('x'), /Connect/);
  assert.equal(status.at(-1).connected, false);
  await session.connect({ path: '/dev/test', baudRate: 9600 });
  await session.disconnect(); assert.equal(session.port, null);
});
test('reject invalid paths, rates, simultaneous opens, and oversized writes', async () => {
  const session = new SerialSession(Port);
  await assert.rejects(session.connect({ path: '/missing', baudRate: 115200 }), /no longer/);
  await assert.rejects(session.connect({ path: '/dev/test', baudRate: -1 }), /valid/);
  const opening = session.connect({ path: '/dev/test', baudRate: 115200 });
  await assert.rejects(session.connect({ path: '/dev/test', baudRate: 115200 }), /Disconnect/);
  await opening;
  await assert.rejects(session.write('x'.repeat(65537)), /64 KB/);
  await session.disconnect();
});
test('failed open leaves session available for retry', async () => {
  class FailingPort extends Port { open(cb) { cb(new Error('Port busy')); } }
  const session = new SerialSession(FailingPort);
  await assert.rejects(session.connect({ path: '/dev/test', baudRate: 115200 }), /Port busy/);
  assert.equal(session.port, null); assert.equal(session.busy, false);
  session.Port = Port; await session.connect({ path: '/dev/test', baudRate: 115200 }); await session.disconnect();
});
