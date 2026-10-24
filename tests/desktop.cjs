const { _electron: electron } = require("@playwright/test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
(async () => {
  const app = await electron.launch({ args: ["."], env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
  try {
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
    await fs.mkdir("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/desktop.png" });
    await page.click("#connect");
    assert.equal(await page.textContent("#badge"), "Disconnected");
    assert.deepEqual(errors, []);
    console.log("Desktop smoke test passed: Ghostty WASM, native discovery, demo, input, disconnect, isolation.");
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
