const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const cli = process.env.SURGE_CLI || "/Applications/Surge.app/Contents/Applications/surge-cli";

test("Surge accepts two rendered modules with comma quantifiers in interface regexes", {
  skip: !fs.existsSync(cli) && "Surge CLI is not installed"
}, () => {
  const source = fs.readFileSync(path.join(__dirname, "../surge_api_debug.sgmodule"), "utf8");
  const sections = new Map();
  let section;
  for (const line of source.split("\n")) {
    if (line.startsWith("[")) {
      section = line;
      sections.set(section, []);
    } else if (section && line.trim()) {
      sections.get(section).push(line);
    }
  }
  const values = {
    direction: "response", target: "body", action: "set", path: "$",
    value: "test", value_type: "string", hit_limit: "1", delay_ms: "0"
  };
  const urls = [
    "^https://api\\.example\\.com/v1/login(?:\\?|$)",
    "^https://api\\.example\\.com/v1/messages/[0-9]{1,3}\\?x=1&foo=2$"
  ];
  const profile = ["[General]", "loglevel=notify"];
  for (const [name, lines] of sections) {
    profile.push(name);
    for (const url of urls) {
      const options = { ...values, url };
      profile.push(...lines.map(line => line.replace(
        /\{\{\{(\w+)\}\}\}/g, (_, key) => options[key]
      )));
    }
  }
  profile.push("[Rule]", "FINAL,DIRECT", "");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "surge-multiple-modules-"));
  try {
    const fixture = path.join(temporary, "two-modules.conf");
    fs.writeFileSync(fixture, profile.join("\n"));
    const result = spawnSync(cli, ["--check", fixture], {
      encoding: "utf8", timeout: 10000
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
