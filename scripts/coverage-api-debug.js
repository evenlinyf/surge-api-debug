#!/usr/bin/env node
// V8's built-in test coverage omits scripts executed with vm.runInNewContext.
// This runner measures the Surge script directly via precise V8 coverage.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const inspector = require("node:inspector");
const path = require("node:path");
const test = require("node:test");

const reportOnly = process.env.SURGE_COVERAGE_REPORT_ONLY === "1";
const minimumRangeCoverage = 95;
const sourcePath = path.join(__dirname, "../surge_api_debug.js");
const source = fs.readFileSync(sourcePath, "utf8");
const session = new inspector.Session();
session.connect();
session.post("Profiler.enable");
session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });

require("../tests/surge_api_debug.test.js");

function inspectorRequest(method) {
  return new Promise((resolve, reject) => {
    session.post(method, (error, response) => error ? reject(error) : resolve(response));
  });
}

function lineAt(offset) {
  return source.slice(0, offset).split("\n").length;
}

test.after(async () => {
  let coverage;
  try {
    coverage = await inspectorRequest("Profiler.takePreciseCoverage");
  } finally {
    session.disconnect();
  }

  const script = coverage.result.find(item => item.url.endsWith("surge_api_debug.js"));
  assert.ok(script, "V8 did not report the VM-executed Surge script");
  const ranges = script.functions.flatMap(item => item.ranges);
  assert.ok(ranges.length > 0, "V8 did not report executable ranges");
  const covered = ranges.filter(range => range.count > 0).length;
  const percentage = (covered / ranges.length) * 100;
  const functionCount = script.functions.filter(item => item.ranges[0].count > 0).length;
  const missedLines = [...new Set(ranges
    .filter(range => range.count === 0)
    .map(range => lineAt(range.startOffset)))].sort((left, right) => left - right);

  process.stdout.write(
    `surge_api_debug.js: V8 ranges ${covered}/${ranges.length} (${percentage.toFixed(1)}%), ` +
    `functions ${functionCount}/${script.functions.length}\n`
  );
  if (missedLines.length) {
    process.stdout.write(`Uncovered range starts: ${missedLines.join(", ")}\n`);
  }
  if (!reportOnly) {
    assert.ok(
      percentage >= minimumRangeCoverage,
      `V8 range coverage ${percentage.toFixed(1)}% is below ${minimumRangeCoverage}%`
    );
  }
});
