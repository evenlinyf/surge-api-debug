const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("API Debug coverage report measures the VM-executed script", () => {
  const runner = path.join(__dirname, "../scripts/coverage-api-debug.js");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.SURGE_COVERAGE_REPORT_ONLY;
  const result = spawnSync(process.execPath, ["--test", runner], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /surge_api_debug\.js: V8 ranges \d+\/\d+ \([\d.]+%\)/);
  assert.doesNotMatch(result.stdout, /V8 ranges 0\/0/);
});
