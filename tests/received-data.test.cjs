const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ReceivedData } = require("../src/received-data.mts");
const bytes = (text) => new TextEncoder().encode(text);
const text = (data) => new TextDecoder().decode(data);

test("a fresh session has no received data and normalizes a leading LF", () => {
  const received = new ReceivedData();
  assert.equal(received.rx, 0);
  assert.equal(received.log, "");
  assert.equal(text(received.receive(bytes("\nhello"))), "\r\nhello");
  assert.equal(received.log, "\nhello");
  assert.equal(received.rx, 6);
});

test("LF-only display normalization leaves received text and byte counts intact", () => {
  const received = new ReceivedData();
  const input = bytes("found device\nscan done\n");
  assert.equal(text(received.receive(input)), "found device\r\nscan done\r\n");
  assert.equal(received.log, text(input));
  assert.equal(received.rx, input.byteLength);
});

test("CRLF remains intact across reads, including empty reads", () => {
  const received = new ReceivedData();
  assert.equal(text(received.receive(bytes("one\r"))), "one\r");
  assert.deepEqual(received.receive(new Uint8Array()), new Uint8Array());
  assert.equal(text(received.receive(bytes("\ntwo\r\nthree\n"))), "\ntwo\r\nthree\r\n");
  assert.equal(received.log, "one\r\ntwo\r\nthree\n");
  assert.equal(received.rx, bytes(received.log).byteLength);
});

test("preserves bare CR, ANSI sequences and split UTF-8 without mutating input", () => {
  const received = new ReceivedData();
  const input = bytes("\x1b[32mprogress\rready\x1b[0m café 🌿\n");
  const original = input.slice();
  const output = Buffer.concat([...input].map((byte) => received.receive(Uint8Array.of(byte))));
  assert.equal(output.toString(), "\x1b[32mprogress\rready\x1b[0m café 🌿\r\n");
  assert.deepEqual(input, original);
  assert.equal(received.log, text(input));
  assert.equal(received.rx, input.byteLength);
});

test("an incomplete UTF-8 character remains pending across empty reads", () => {
  const received = new ReceivedData();
  received.receive(Uint8Array.of(0xc3));
  received.receive(new Uint8Array());
  assert.equal(received.log, "");
  assert.equal(received.rx, 1);
  received.receive(Uint8Array.of(0xa9));
  assert.equal(received.log, "é");
  assert.equal(received.rx, 2);
});

test("reset clears received text, RX and a pending CR", () => {
  const received = new ReceivedData();
  received.receive(bytes("old session\r"));
  received.reset();
  assert.equal(received.rx, 0);
  assert.equal(received.log, "");
  assert.equal(text(received.receive(bytes("\nnew"))), "\r\nnew");
  assert.equal(received.log, "\nnew");
  assert.equal(received.rx, 4);
});

test("reset discards incomplete UTF-8 from the previous session", () => {
  const received = new ReceivedData();
  received.receive(Uint8Array.of(0xc3));
  received.reset();
  received.receive(Uint8Array.of(0xa9));
  assert.equal(received.log, "�");
  assert.equal(received.rx, 1);
});

test("retains the latest 4 Mi UTF-16 code units while counting and displaying every byte", () => {
  const received = new ReceivedData();
  const limit = 4 * 1024 * 1024;
  const initial = "é".repeat(limit - 1);
  const first = bytes(initial);
  assert.deepEqual(received.receive(first), first);
  assert.equal(received.log, initial);
  assert.deepEqual(received.receive(bytes("xy")), bytes("xy"));
  assert.equal(received.log, `${initial.slice(1)}xy`);
  assert.equal(received.log.length, limit);
  assert.equal(received.rx, first.byteLength + 2);
});
