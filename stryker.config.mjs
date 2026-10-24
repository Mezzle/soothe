export default {
  // Exercise the serial lifecycle and byte handling without opening hardware or a GUI.
  mutate: ["electron/serial.cjs", "src/received-data.mts", "src/console-session.mts"],
  testRunner: "command",
  commandRunner: { command: "npm test" },
  coverageAnalysis: "off",
  // node:test runs native TypeScript directly. The tsconfig is not a test input;
  // excluding it also avoids Stryker's dependency on the removed TypeScript 7 compiler API.
  ignorePatterns: ["dist", "release", "test-results", "reports", ".fallow", ".claude", "tsconfig.json"],
  thresholds: { high: 100, low: 100, break: 100 },
  reporters: ["clear-text", "progress", "html", "json"],
  clearTextReporter: { allowEmojis: false, logTests: false },
  concurrency: 4,
};
