const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { checkRelease } = require("../scripts/check-release.js");

// Fixed fixtures let future source versions change without rewriting the validator tests.
const script = '/** Script Version: 1.0.0 */\nconst SCRIPT_VERSION = "1.0.0";';
const moduleSource = `#!desc=Module v1.0.0，Script v1.0.0。
[Script]
API Debug = type=http-response, script-path=https://raw.githubusercontent.com/evenlinyf/surge-api-debug/v1.0.0/surge_api_debug.js, argument="module_version=1.0.0"
API-Debug-Reset = type=generic, script-path=https://raw.githubusercontent.com/evenlinyf/surge-api-debug/v1.0.0/surge_api_debug.js, argument="target=reset&module_version=1.0.0"
`;

test("release CLI validates the real checkout and fails on an incorrect tag", () => {
  const runner = path.join(__dirname, "../scripts/check-release.js");
  const valid = spawnSync(process.execPath, [runner], { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /^v\d+\.\d+\.\d+\n$/);
  const invalid = spawnSync(process.execPath, [runner, "not-a-release-tag"], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /release tag differs/i);
});

test("release validation derives a tag from paired source versions", () => {
  assert.equal(checkRelease(script, moduleSource), "v1.0.0");
  assert.equal(checkRelease(script, moduleSource, "v1.0.0"), "v1.0.0");
});

test("release validation rejects a tag that differs from the source", () => {
  assert.throws(() => checkRelease(script, moduleSource, "v9.0.0"), /tag/i);
});

test("release validation rejects missing or unstable script versions", () => {
  for (const version of ["", "1.0.0-rc.1", "01.0.0"]) {
    assert.throws(() => checkRelease(
      script.replace('const SCRIPT_VERSION = "1.0.0";', `const SCRIPT_VERSION = "${version}";`),
      moduleSource
    ), /version/i);
  }
});

test("release validation checks the script header and Module description", () => {
  assert.throws(() => checkRelease(
    script.replace("Script Version: 1.0.0", "Script Version: 0.9.0"), moduleSource
  ), /version/i);
  for (const label of ["Module", "Script"]) {
    assert.throws(() => checkRelease(script,
      moduleSource.replace(`${label} v1.0.0`, `${label} v0.9.0`)
    ), /version/i);
  }
});

test("release validation checks both HTTP and reset script URLs and arguments", () => {
  const lines = moduleSource.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].includes("script-path=")) continue;
    for (const [before, after] of [
      ["/v1.0.0/", "/main/"],
      ["module_version=1.0.0", "module_version=0.9.0"],
      ["surge_api_debug.js", "other.js"]
    ]) {
      const changed = [...lines];
      changed[index] = changed[index].replace(before, after);
      assert.throws(() => checkRelease(script, changed.join("\n")), /script|version/i);
    }
    assert.throws(() => checkRelease(script,
      lines.filter((_, i) => i !== index).join("\n")
    ), /script/i);
  }
});
