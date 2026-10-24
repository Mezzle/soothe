const { _electron: electron } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
(async () => {
  const app = await electron.launch({ args: ["."], env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
  let originalClipboard;
  try {
    originalClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForSelector("#terminal canvas");
    await page.waitForFunction(() => document.querySelector("#devices").textContent.length > 0);
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    const ports = await page.evaluate(() => window.serial.list());
    console.log(
      "Native port discovery:",
      ports.map((p) => p.path),
    );
    await page.click("#demo");
    await page.waitForFunction(() => document.querySelector("#bytes").textContent !== "RX 0 B  /  TX 0 B");
    assert.equal(await page.textContent("#badge"), "Demo session");
    await page.fill("#command", "hello atom");
    await page.click("#send");
    assert.match(await page.textContent("#bytes"), /TX 12 B/);
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.send("serial:status", { connected: false, error: "retired native event" });
      window.webContents.send("serial:data", new TextEncoder().encode("ignored-native-data"));
    });
    // A renderer round trip follows the queued native events.
    await page.evaluate(() => window.serial.list());
    assert.equal(await page.textContent("#badge"), "Demo session");
    assert.doesNotMatch(await page.textContent("#notice"), /retired native event/);
    await fs.mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/desktop.png" });
    await page.click("#connect");
    assert.equal(await page.textContent("#badge"), "Disconnected");
    const stoppedBytes = await page.textContent("#bytes");
    await page.waitForTimeout(2600);
    assert.equal(await page.textContent("#bytes"), stoppedBytes);
    assert.equal(await page.isDisabled("#command"), true);
    await page.click("#copy");
    const copiedLog = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.match(copiedLog, /received: hello atom/);
    assert.doesNotMatch(copiedLog, /ignored-native-data/);
    // Compare frozen session data so a live heartbeat cannot race the assertions.
    await page.click("#clear");
    assert.equal(await page.textContent("#bytes"), stoppedBytes);
    await page.click("#copy");
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), copiedLog);
    await page.click("#demo");
    assert.match(await page.textContent("#bytes"), /TX 0 B/);
    await page.click("#connect");
    assert.deepEqual(errors, []);
    console.log("Desktop smoke test passed: Ghostty WASM, native discovery, demo, input, disconnect, isolation.");
  } finally {
    try {
      if (originalClipboard !== undefined) {
        await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), originalClipboard);
      }
    } finally {
      await app.close();
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
