const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function checkRelease(script, moduleSource, expectedTag) {
  const version = script.match(/^const SCRIPT_VERSION = "([^"]+)";/m)?.[1];
  assert.match(version || "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "invalid stable script version");
  const tag = `v${version}`;
  if (expectedTag) assert.equal(expectedTag, tag, "release tag differs from source version");
  assert.equal(script.match(/Script Version: (\S+)/)?.[1], version, "script header version mismatch");
  const description = moduleSource.match(/^#!desc=(.*)$/m)?.[1] || "";
  assert.equal(description.match(/Module v([\d.]+)/)?.[1], version, "Module description version mismatch");
  assert.equal(description.match(/Script v([\d.]+)/)?.[1], version, "Module script version mismatch");

  const entries = moduleSource.split("\n").filter(line => line.includes("script-path="));
  assert.equal(entries.length, 2, "expected HTTP and reset script entries");
  for (const entry of entries) {
    assert.equal(entry.match(/script-path=([^,\s]+)/)?.[1],
      `https://raw.githubusercontent.com/evenlinyf/surge-api-debug/${tag}/surge_api_debug.js`,
      "script URL must use the matching release tag");
    assert.equal(entry.match(/module_version=([^&"\s]+)/)?.[1], version, "script argument version mismatch");
  }
  return tag;
}

module.exports = { checkRelease };

if (require.main === module) {
  try {
    const root = path.join(__dirname, "..");
    console.log(checkRelease(
      fs.readFileSync(path.join(root, "surge_api_debug.js"), "utf8"),
      fs.readFileSync(path.join(root, "surge_api_debug.sgmodule"), "utf8"),
      process.argv[2]
    ));
  } catch (error) {
    console.error(`Release validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
