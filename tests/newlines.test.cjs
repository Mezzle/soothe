const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ReceivedNewlines } = require('../src/received-newlines.mts');
const bytes = text => new TextEncoder().encode(text);
const text = data => new TextDecoder().decode(data);

test('LF-only serial output starts each line at column one', () => {
  const display = new ReceivedNewlines();
  assert.equal(text(display.transform(bytes('found device\nscan done\n'))), 'found device\r\nscan done\r\n');
});
test('CRLF remains intact even across serial chunks', () => {
  const display = new ReceivedNewlines();
  assert.equal(text(display.transform(bytes('one\r'))), 'one\r');
  assert.equal(text(display.transform(bytes('\ntwo\r\nthree\n'))), '\ntwo\r\nthree\r\n');
});
test('preserves bare CR, ANSI sequences and split UTF-8 bytes', () => {
  const display = new ReceivedNewlines();
  const input = bytes('\x1b[32mprogress\rready\x1b[0m café\n');
  const original = input.slice();
  const output = Buffer.concat([...input].map(byte => display.transform(Uint8Array.of(byte))));
  assert.equal(output.toString(), '\x1b[32mprogress\rready\x1b[0m café\r\n');
  assert.deepEqual(input, original);
});
test('reset clears pending CR from the previous connection', () => {
  const display = new ReceivedNewlines();
  display.transform(bytes('\r')); display.transform(new Uint8Array()); display.reset();
  assert.equal(text(display.transform(bytes('\n'))), '\r\n');
});
