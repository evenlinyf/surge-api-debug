const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const CURRENT_VERSION = "1.5.0";

const scriptSource = fs.readFileSync(
  path.join(__dirname, "../surge_api_debug.js"),
  "utf8"
);

function runScript({
  argument,
  direction = "response",
  requestUrl = "https://example.com/api",
  body = "",
  headers = {},
  scriptName = "API Debug",
  input,
  trigger,
  persistentStore,
  moduleVersion = CURRENT_VERSION
}) {
  let result;
  const logs = [];
  const timers = [];
  const context = {
    $argument:
      moduleVersion == null
        ? argument
        : `${argument}&module_version=${moduleVersion}`,
    $script: { name: scriptName },
    $input: input,
    $trigger: trigger,
    $persistentStore: persistentStore,
    $done(value) {
      result = value || {};
    },
    console: {
      log(message) {
        logs.push(String(message));
      }
    },
    setTimeout(callback, milliseconds) {
      timers.push(milliseconds);
      callback();
    }
  };

  if (direction === "response") {
    context.$request = { url: requestUrl, headers: {} };
    context.$response = { status: 200, headers, body };
  } else if (direction === "request") {
    context.$request = { url: requestUrl, headers, body };
  }

  vm.runInNewContext(scriptSource, context, { filename: "surge_api_debug.js" });

  return { result, logs, timers };
}

function createPersistentStore() {
  const entries = new Map();
  return {
    read: key => entries.get(key) ?? null,
    write(value, key) {
      if (value === null) entries.delete(key);
      else entries.set(key, value);
      return true;
    }
  };
}

function createModuleInstance(persistentStore, options = {}) {
  const source = fs.readFileSync(path.join(__dirname, "../surge_api_debug.sgmodule"), "utf8");
  const values = {
    url: "^https://example.com/login$", direction: "response", target: "body",
    action: "set", path: "$", value: "login", value_type: "string",
    hit_limit: "1", delay_ms: "0", ...options
  };
  const render = line => line.match(/\bargument="([^"]+)"/)[1]
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, name) => values[name]);
  const httpLine = source.split("\n").find(line => line.includes("type=http-"));
  const resetLine = source.split("\n").find(line => line.includes("type=generic"));
  return {
    hit: (overrides = {}) => runScript({
      argument: render(httpLine), moduleVersion: null, persistentStore,
      direction: values.direction, scriptName: "API Debug (Surge API Debug)",
      ...overrides
    }),
    panel: (trigger = "button") => runScript({
      argument: render(resetLine), moduleVersion: null, persistentStore,
      direction: null, scriptName: "API-Debug-Reset (Surge API Debug)",
      input: { purpose: "panel", panelName: "API-Debug-Reset" }, trigger
    })
  };
}

test("every log line identifies its module rule and HTTP direction", () => {
  const store = createPersistentStore();
  for (const [options, prefix] of [
    [{}, "[Surge API Debug][response][^https://example.com/login$] "],
    [{ url: "^https://example.com/messages$" }, "[Surge API Debug][response][^https://example.com/messages$] "],
    [{ direction: "request" }, "[Surge API Debug][request][^https://example.com/login$] "]
  ]) {
    const instance = createModuleInstance(store, options);
    for (const { logs } of [instance.hit(), instance.hit()]) {
      assert.ok(logs.length > 0);
      for (const line of logs) assert.ok(line.startsWith(prefix), line);
    }
  }
});

test("reset logs use the configured direction even without an HTTP packet", () => {
  for (const direction of ["request", "response"]) {
    const instance = createModuleInstance(createPersistentStore(), { direction });
    instance.hit();
    const { logs } = instance.panel();
    assert.ok(logs.some(line => line.includes("hit counter reset")));
    for (const line of logs) {
      assert.ok(line.startsWith(`[Surge API Debug][${direction}][^https://example.com/login$] `), line);
    }
  }
});

test("version errors retain rule context and missing rules have an explicit fallback", () => {
  const { logs } = runScript({
    argument: "url_pattern=^https://example.com/login$, target=body",
    moduleVersion: "old"
  });
  assert.ok(logs.some(line => line.includes("version mismatch")));
  for (const line of logs) {
    assert.ok(line.startsWith("[Surge API Debug][response][^https://example.com/login$] "), line);
  }
  const fallback = runScript({ argument: undefined, moduleVersion: null });
  assert.ok(fallback.logs.length > 0);
  for (const line of fallback.logs) {
    assert.ok(line.startsWith("[Surge API Debug][response][unconfigured] "), line);
  }
});

test("interleaved modules keep independent positive limits despite identical script names", () => {
  const store = createPersistentStore();
  const login = createModuleInstance(store, { hit_limit: "2" });
  const messages = createModuleInstance(store, {
    url: "^https://example.com/messages$", value: "messages"
  });
  assert.equal(login.hit().result.body, "login");
  assert.equal(messages.hit().result.body, "messages");
  assert.equal(login.hit().result.body, "login");
  assert.equal(messages.hit().result.body, undefined);
  assert.equal(login.hit().result.body, undefined);
});

test("one module's skipped hits do not consume or restart another module's quota", () => {
  const store = createPersistentStore();
  const login = createModuleInstance(store, { hit_limit: "-2" });
  const messages = createModuleInstance(store, {
    url: "^https://example.com/messages$", value: "messages"
  });
  assert.equal(login.hit().result.body, undefined);
  assert.equal(messages.hit().result.body, "messages");
  assert.equal(login.hit().result.body, undefined);
  assert.equal(messages.hit().result.body, undefined);
  assert.equal(login.hit().result.body, "login");
  assert.equal(login.hit().result.body, "login");
  assert.equal(messages.hit().result.body, undefined);
});

test("a panel reset clears only its configured pattern and direction", () => {
  const store = createPersistentStore();
  const login = createModuleInstance(store);
  const request = createModuleInstance(store, { direction: "request" });
  const messages = createModuleInstance(store, {
    url: "^https://example.com/messages$", value: "messages"
  });
  assert.equal(login.hit().result.body, "login");
  assert.equal(request.hit().result.body, "login");
  assert.equal(messages.hit().result.body, "messages");
  assert.equal(login.panel("auto-interval").result.style, "info");
  assert.equal(login.hit().result.body, undefined);
  assert.equal(login.panel().result.style, "good");
  assert.equal(login.hit().result.body, "login");
  assert.equal(login.hit().result.body, undefined);
  assert.equal(messages.hit().result.body, undefined);
  assert.equal(request.hit().result.body, undefined);
  assert.equal(messages.panel().result.style, "good");
  assert.equal(messages.hit().result.body, "messages");
  assert.equal(login.hit().result.body, undefined);
});

test("unlimited mode clears only the matching module's counter", () => {
  const store = createPersistentStore();
  const login = createModuleInstance(store);
  const messages = createModuleInstance(store, { url: "^https://example.com/messages$" });
  assert.equal(login.hit().result.body, "login");
  assert.equal(messages.hit().result.body, "login");
  assert.equal(createModuleInstance(store, { hit_limit: "0" }).hit().result.body, "login");
  assert.equal(login.hit().result.body, "login");
  assert.equal(messages.hit().result.body, undefined);
  assert.equal(login.hit().result.body, undefined);
});

test("changing a module's limit preserves other patterns' exhausted counters", () => {
  const store = createPersistentStore();
  const login = createModuleInstance(store);
  const messages = createModuleInstance(store, { url: "^https://example.com/messages$" });
  login.hit();
  messages.hit();
  const changed = createModuleInstance(store, { hit_limit: "2" });
  assert.equal(changed.hit().result.body, "login");
  assert.equal(messages.hit().result.body, undefined);
  assert.equal(changed.hit().result.body, "login");
  assert.equal(changed.hit().result.body, undefined);
});

test("exact regex patterns containing delimiters, percent escapes or Unicode do not alias", () => {
  const store = createPersistentStore();
  const patterns = [
    "^https://example.com/a/b$", "^https://example.com/a%2Fb$",
    "^https://example.com/a\\?x=1&value_type=number$",
    "^https://example.com/a\\?x=1%26value_type=number$",
    "^https://example.com/items/[0-9]{1,3}$", "^https://example.com/消息$"
  ];
  const modules = patterns.map(url => createModuleInstance(store, { url }));
  for (const module of modules) assert.equal(module.hit().result.body, "login");
  for (const module of modules) assert.equal(module.hit().result.body, undefined);
  assert.equal(modules[2].panel().result.style, "good");
  assert.equal(modules[2].hit().result.body, "login");
  assert.equal(modules[3].hit().result.body, undefined);
});

test("the same pattern and direction share a counter independently of script names", () => {
  const store = createPersistentStore();
  const first = createModuleInstance(store);
  const second = createModuleInstance(store, { value: "other" });
  assert.equal(first.hit().result.body, "login");
  assert.equal(second.hit({ scriptName: "A different installed instance" }).result.body, undefined);
  assert.equal(second.panel().result.style, "good");
  assert.equal(first.hit().result.body, "login");
  assert.equal(second.hit().result.body, undefined);
});

test("new pattern counters do not consume or clear the old global module counter", () => {
  const store = createPersistentStore();
  const oldKey = "surge-api-debug-hits-v2-module-response";
  const oldState = JSON.stringify({ count: 1, limit: 1, urlPattern: "^https://example.com/login$" });
  store.write(oldState, oldKey);
  const module = createModuleInstance(store);
  assert.equal(module.hit().result.body, "login");
  assert.equal(module.hit().result.body, undefined);
  assert.equal(module.panel().result.style, "good");
  assert.equal(store.read(oldKey), oldState);
});

test("reset panel feedback identifies the affected interface and direction", () => {
  const store = createPersistentStore();
  const url = "^https://example.com/messages$";
  const module = createModuleInstance(store, { url, direction: "request" });
  for (const trigger of ["auto-interval", "button"]) {
    const result = module.panel(trigger).result;
    assert.ok(result.content.includes(url));
    assert.ok(result.content.includes("request"));
  }
  store.write = () => false;
  module.hit();
  store.read = () => "existing";
  const failed = module.panel().result;
  assert.equal(failed.style, "error");
  assert.ok(failed.content.includes(url));
});

test("only a manual Surge panel click clears the selected direction's quota", () => {
  const moduleSource = fs.readFileSync(path.join(
    __dirname, "../surge_api_debug.sgmodule"
  ), "utf8");
  const panel = moduleSource.match(/^([^\n=]+) = title="重置次数".*script-name=([^\n,]+).*$/m);
  assert.ok(panel, "the reset panel is linked to a script");
  const [, panelName, resetScriptName] = panel;
  const httpLine = moduleSource.split("\n").find(line => line.includes("type=http-"));
  const resetLine = moduleSource.split("\n").find(line => line.startsWith(`${resetScriptName} = type=generic,`));
  assert.ok(resetLine);
  const values = {
    url: "example.com/api", target: "body", action: "set", path: "$",
    value: "applied", value_type: "string", hit_limit: "1", delay_ms: "0"
  };
  const persistentStore = createPersistentStore();
  const render = (line, direction) => line.match(/\bargument="([^"]+)"/)[1]
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, name) => name === "direction" ? direction : values[name]);
  const request = direction => runScript({
    argument: render(httpLine, direction), moduleVersion: null, direction,
    scriptName: "API Debug (Surge API Debug)", persistentStore
  }).result.body;
  const runPanel = (trigger, input = { purpose: "panel", panelName }) => runScript({
    argument: render(resetLine, "response"), moduleVersion: null, direction: null,
    scriptName: `${resetScriptName} (Surge API Debug)`, persistentStore, input, trigger
  });

  assert.equal(request("request"), "applied");
  assert.equal(request("response"), "applied");
  assert.equal(request("response"), undefined);
  runPanel("auto-interval");
  runPanel("button", { purpose: "other", panelName });
  assert.equal(request("response"), undefined);
  const reset = runPanel("button");
  assert.equal(reset.result.title, "重置次数");
  assert.equal(reset.result.style, "good");
  assert.deepEqual(reset.timers, []);
  assert.equal(request("request"), undefined);
  assert.equal(request("response"), "applied");
  assert.equal(request("response"), undefined);

  const reopened = runPanel("auto-interval");
  assert.equal(reopened.result.style, "info");
  assert.match(reopened.result.content, /点刷新清零/);
  assert.equal(request("response"), undefined);
  assert.equal(runPanel("button").result.style, "good");
  assert.equal(request("response"), "applied");
  assert.equal(request("response"), undefined);

  persistentStore.write = () => false;
  assert.equal(runPanel("button").result.style, "error");
  assert.equal(request("response"), undefined);
  assert.match(panel[0], /(?:^|,\s*)update-interval=1(?:,|$)/);
});

test("Module URL patterns retain independent quotas while one regex shares its quota across requests", () => {
  const moduleSource = fs.readFileSync(path.join(
    __dirname, "../surge_api_debug.sgmodule"
  ), "utf8");
  const template = moduleSource.match(/\bargument="([^"]+)"/)?.[1];
  assert.ok(template);
  const persistentStore = createPersistentStore();
  const run = (url, id) => {
    const values = {
      url, target: "body", action: "set", hit_limit: "1", path: "$",
      value: "A, target=B&hit_limit=99", value_type: "string", delay_ms: "0"
    };
    const argument = template.replace(/\{\{\{(\w+)\}\}\}/g, (_, name) => values[name]);
    return runScript({
      argument, moduleVersion: null, persistentStore,
      requestUrl: `https://example.com/api/${id}?x=1&module_version=unrelated&value_type=unrelated`
    }).result.body;
  };
  const first = "example.com/api/[0-9]{1,3}\\?x=1&module_version=unrelated&value_type=unrelated";
  const second = "example.com/api/(1|2)\\?x=1&module_version=unrelated&value_type=unrelated";
  assert.equal(run(first, 1), "A, target=B&hit_limit=99");
  assert.equal(run(first, 2), undefined);
  assert.equal(run(second, 1), "A, target=B&hit_limit=99");
  assert.equal(run(second, 2), undefined);
  assert.equal(run(first, 2), undefined);
});

test("positive hit_limit applies to the first N requests without delaying later requests", () => {
  const persistentStore = createPersistentStore();
  const run = () => runScript({
    argument: "hit_limit=2&target=status&value=500&value_type=number&delay_ms=10",
    persistentStore
  });
  assert.equal(run().result.status, 500);
  assert.equal(run().result.status, 500);
  const skipped = run();
  assert.deepEqual(Object.keys(skipped.result), []);
  assert.deepEqual(skipped.timers, []);
});

test("negative hit_limit skips the first N hits and applies to all subsequent hits", () => {
  const persistentStore = createPersistentStore();
  const run = () => runScript({
    argument: "action=abort&hit_limit=-2&delay_ms=10",
    persistentStore
  });
  assert.deepEqual(Object.keys(run().result), []);
  const skipped = run();
  assert.deepEqual(Object.keys(skipped.result), []);
  assert.deepEqual(skipped.timers, []);
  assert.equal(run().result.abort, true);
  assert.equal(run().result.abort, true);
});

test("only applicable requests consume quota, even when several items match a filter", () => {
  const persistentStore = createPersistentStore();
  const argument = "hit_limit=2&action=format&path=items[?(@.match == true)].content&value=pre-${old}&value_type=string";
  const run = body => runScript({ argument, body, persistentStore }).result;
  assert.deepEqual(Object.keys(run("bad JSON")), []);
  assert.deepEqual(Object.keys(run('{"items":[{"match":false,"content":"a"}]}')), []);
  assert.deepEqual(Object.keys(run('{"items":[{"match":true,"content":4}]}')), []);
  const matching = '{"items":[{"match":true,"content":"a"},{"match":true,"content":"b"}]}';
  const modified = { items: [{ match: true, content: "pre-a" }, { match: true, content: "pre-b" }] };
  assert.deepEqual(JSON.parse(run(matching).body), modified);
  assert.deepEqual(JSON.parse(run(matching).body), modified);
  assert.deepEqual(Object.keys(run(matching)), []);
});

test("removing an absent header does not consume the first hit", () => {
  const persistentStore = createPersistentStore();
  const run = headers => runScript({
    argument: "target=header&action=remove&hit_limit=1&path=X-Debug",
    headers,
    persistentStore
  }).result;
  assert.deepEqual(Object.keys(run({ Keep: "yes" })), []);
  assert.deepEqual({ ...run({ Keep: "yes", "x-debug": "remove" }).headers }, { Keep: "yes" });
  assert.deepEqual(Object.keys(run({ "X-Debug": "remove" })), []);
});

test("a qualifying hit with hit_limit=0 clears an exhausted quota and still applies", () => {
  const persistentStore = createPersistentStore();
  const run = limit => runScript({
    argument: `target=status&hit_limit=${limit}&value=500`,
    persistentStore
  }).result;
  assert.equal(run(1).status, 500);
  assert.deepEqual(Object.keys(run(1)), []);
  assert.equal(run(0).status, 500);
  assert.equal(run(0).status, 500);
  assert.equal(run(1).status, 500);
  assert.deepEqual(Object.keys(run(1)), []);
});

test("a nonmatching header removal with hit_limit=0 leaves the stored count alone", () => {
  const persistentStore = createPersistentStore();
  const run = (limit, headers) => runScript({
    argument: `target=header&action=remove&hit_limit=${limit}&path=X-Debug`,
    headers,
    persistentStore
  }).result;
  assert.deepEqual({ ...run(1, { "X-Debug": "test" }).headers }, {});
  run(0, { Keep: "yes" });
  assert.deepEqual(Object.keys(run(1, { "X-Debug": "test" })), []);
});

test("corrupt stored counters pass through until a qualifying hit with hit_limit=0 resets them", () => {
  const persistentStore = createPersistentStore();
  const run = limit => runScript({
    argument: `action=abort&hit_limit=${limit}`,
    persistentStore
  }).result;
  const save = persistentStore.write;
  persistentStore.write = (_, key) => save("{}", key);
  assert.equal(run(1).abort, true);
  persistentStore.write = save;
  assert.deepEqual(Object.keys(run(1)), []);
  assert.equal(run(0).abort, true);
  assert.equal(run(1).abort, true);
  assert.deepEqual(Object.keys(run(1)), []);
});

test("a failed reset preserves unlimited behavior and leaves the previous quota exhausted", () => {
  const persistentStore = createPersistentStore();
  const run = limit => runScript({
    argument: `action=abort&hit_limit=${limit}`,
    persistentStore
  });
  assert.equal(run(1).result.abort, true);
  const save = persistentStore.write;
  persistentStore.write = () => false;
  const reset = run(0);
  assert.equal(reset.result.abort, true);
  assert.ok(reset.logs.some(message => message.includes("could not reset hit counter")));
  persistentStore.write = save;
  assert.deepEqual(Object.keys(run(1).result), []);
});

test("counter state is independent for different script names and directions", () => {
  const persistentStore = createPersistentStore();
  const run = (scriptName, direction) => runScript({
    argument: "action=abort&hit_limit=1", scriptName, direction, persistentStore
  }).result;
  assert.equal(run("API Debug / A", "response").abort, true);
  assert.deepEqual(Object.keys(run("API Debug / A", "response")), []);
  assert.equal(run("API Debug / B", "response").abort, true);
  assert.equal(run("API Debug / A", "request").abort, true);
});

test("changing the nonzero limit starts a new sequence on the next qualifying hit", () => {
  const persistentStore = createPersistentStore();
  const run = limit => runScript({
    argument: `action=mock&hit_limit=${limit}&value=mock`,
    direction: "request",
    persistentStore
  }).result;
  assert.equal(run(1).response.body, "mock");
  assert.deepEqual(Object.keys(run(1)), []);
  assert.equal(run(2).response.body, "mock");
  assert.equal(run(2).response.body, "mock");
  assert.deepEqual(Object.keys(run(2)), []);
});

test("blank and zero limits work without storage, while invalid or untracked limits pass through", () => {
  for (const limit of ["", " ", "0"]) {
    assert.equal(runScript({ argument: `action=abort&hit_limit=${limit}` }).result.abort, true);
  }
  for (const limit of ["1.5", "1e2", "9007199254740992", "bad"]) {
    const { result } = runScript({
      argument: `action=abort&hit_limit=${limit}`,
      persistentStore: createPersistentStore()
    });
    assert.deepEqual(Object.keys(result), [], limit);
  }
  assert.deepEqual(Object.keys(runScript({ argument: "action=abort&hit_limit=1" }).result), []);
  const failedWrite = { read: () => null, write: () => false };
  assert.deepEqual(Object.keys(runScript({
    argument: "action=abort&hit_limit=1", persistentStore: failedWrite
  }).result), []);
});

test("matching module and script versions allow mutation", () => {
  const { result, logs } = runScript({
    argument:
      "target=body&action=set&path=data.version&value=matched&value_type=string&delay_ms=0",
    body: JSON.stringify({ data: { version: "before" } })
  });

  assert.deepEqual(JSON.parse(result.body), { data: { version: "matched" } });
  assert.ok(
    logs.some(message =>
      message.includes(
        `script_version=${CURRENT_VERSION}, module_version=${CURRENT_VERSION}`
      )
    )
  );
});

test("missing module version skips mutation", () => {
  const { result, logs } = runScript({
    argument:
      "target=body&action=set&path=data.version&value=changed&value_type=string&delay_ms=0",
    body: JSON.stringify({ data: { version: "before" } }),
    moduleVersion: null
  });

  assert.deepEqual(Object.keys(result), []);
  assert.ok(
    logs.some(message =>
      message.includes(
        `version mismatch: script=${CURRENT_VERSION}, module=missing`
      )
    )
  );
});

test("mismatched module version skips mutation", () => {
  const { result, logs } = runScript({
    argument:
      "target=body&action=set&path=data.version&value=changed&value_type=string&delay_ms=0",
    body: JSON.stringify({ data: { version: "before" } }),
    moduleVersion: "1.0.0"
  });

  assert.deepEqual(Object.keys(result), []);
  assert.ok(
    logs.some(message =>
      message.includes(
        `version mismatch: script=${CURRENT_VERSION}, module=1.0.0`
      )
    )
  );
});

test("the HTTP and panel scripts both use the matching GitHub release tag", () => {
  const moduleSource = fs.readFileSync(
    path.join(__dirname, "../surge_api_debug.sgmodule"),
    "utf8"
  );
  const scriptLines = moduleSource.split("\n").filter(line => line.includes("script-path="));
  assert.equal(scriptLines.length, 2);
  const expectedPath =
    `https://raw.githubusercontent.com/evenlinyf/surge-api-debug/v${CURRENT_VERSION}/surge_api_debug.js`;
  for (const line of scriptLines) {
    assert.equal(line.match(/script-path=([^,\s]+)/)?.[1], expectedPath);
    assert.ok(line.endsWith(`&module_version=${CURRENT_VERSION}"`));
  }
  assert.ok(moduleSource.split("\n")[1].includes(
    `Module v${CURRENT_VERSION}，Script v${CURRENT_VERSION}`
  ));
  assert.ok(scriptSource.includes(`const SCRIPT_VERSION = "${CURRENT_VERSION}";`));
});

test("module argument metadata remains in one contiguous header block", () => {
  const moduleSource = fs.readFileSync(
    path.join(__dirname, "../surge_api_debug.sgmodule"),
    "utf8"
  );
  const headerLines = moduleSource.split("\n").slice(0, 4);

  assert.ok(headerLines.every(line => line.startsWith("#!")));
  assert.ok(headerLines.some(line => line.startsWith("#!arguments=")));
  assert.ok(headerLines.some(line => line.startsWith("#!arguments-desc=")));
});

test("module declares every editable argument and required script option", () => {
  const moduleSource = fs.readFileSync(
    path.join(__dirname, "../surge_api_debug.sgmodule"), "utf8"
  );
  assert.match(moduleSource, /^#!name=Surge API Debug$/m);
  assert.match(moduleSource, /^#!arguments=url,direction:response,target:body,action:set,path,value,value_type:string,hit_limit:0,delay_ms:0$/m);
  assert.match(moduleSource, /^#!arguments-desc=.*url=.*direction=.*target=.*action=.*path=.*value=.*value_type=.*hit_limit=.*delay_ms=/m);
  assert.match(moduleSource, /type=http-\{\{\{direction\}\}\}/);
  assert.match(moduleSource, /pattern="\{\{\{url\}\}\}"/);
  assert.match(moduleSource, /argument="url_pattern=\{\{\{url\}\}\}, target=/);
  assert.match(moduleSource, /requires-body=true, max-size=4194304, timeout=30, debug=true/);
  for (const parameter of ["target", "action", "hit_limit", "path", "value", "value_type", "delay_ms"]) {
    assert.ok(moduleSource.includes(`${parameter}={{{${parameter}}}}`));
  }
});

test("module argument template passes a filtered path into the shared script", () => {
  const moduleSource = fs.readFileSync(
    path.join(__dirname, "../surge_api_debug.sgmodule"), "utf8"
  );
  const template = moduleSource.match(/\bargument="([^"]+)"/)?.[1];
  assert.ok(template);
  const values = {
    url: "https://example.com/api", target: "body", action: "set", hit_limit: "0",
    path: "data.messageList[?(@.createTime == 7 && @.role == 0)].content",
    value: "@empty", value_type: "string", delay_ms: "0"
  };
  const argument = template.replace(/\{\{\{(\w+)\}\}\}/g, (_, name) => values[name]);
  const { result } = runScript({
    argument,
    moduleVersion: null,
    body: JSON.stringify({ data: { messageList: [
      { createTime: 7, role: 0, content: "a" },
      { createTime: 7, role: 1, content: "b" }
    ] } })
  });
  assert.deepEqual(JSON.parse(result.body).data.messageList.map(item => item.content), ["", "b"]);
});

test("module argument template passes format and escaped delimiters", () => {
  const moduleSource = fs.readFileSync(
    path.join(__dirname, "../surge_api_debug.sgmodule"), "utf8"
  );
  const template = moduleSource.match(/\bargument="([^"]+)"/)?.[1];
  assert.ok(template);
  const values = {
    url: "https://example.com/api", target: "body", action: "format", hit_limit: "0", path: "items[?(@.role == 0)].content",
    value: "${old}%26more", value_type: "string", delay_ms: "0"
  };
  const argument = template.replace(/\{\{\{(\w+)\}\}\}/g, (_, name) => values[name]);
  const { result } = runScript({
    argument,
    moduleVersion: null,
    body: JSON.stringify({ items: [{ role: 0, content: "one" }, { role: 0, content: "two" }] })
  });
  assert.deepEqual(JSON.parse(result.body).items.map(item => item.content), ["one&more", "two&more"]);
});

test("module value accepts raw ampersands without losing later options", () => {
  const moduleSource = fs.readFileSync(
    path.join(__dirname, "../surge_api_debug.sgmodule"), "utf8"
  );
  const template = moduleSource.match(/\bargument="([^"]+)"/)?.[1];
  assert.ok(template);
  const values = {
    url: "https://example.com/api", target: "body", action: "format", hit_limit: "0", path: "data.text",
    value: "pre&${old}&post", value_type: "string", delay_ms: "15"
  };
  const argument = template.replace(/\{\{\{(\w+)\}\}\}/g, (_, name) => values[name]);
  const { result, timers } = runScript({
    argument,
    moduleVersion: null,
    body: JSON.stringify({ data: { text: "before" } })
  });
  assert.equal(JSON.parse(result.body).data.text, "pre&before&post");
  assert.deepEqual(timers, [15]);
});

test("Module preserves raw ampersands in values while applying a signed hit limit", () => {
  const moduleSource = fs.readFileSync(
    path.join(__dirname, "../surge_api_debug.sgmodule"),
    "utf8"
  );
  const template = moduleSource.match(/\bargument="([^"]+)"/)?.[1];
  assert.ok(template);

  for (const [limit, expected] of [
    ["3", ["A&hit_limit=99", "A&hit_limit=99", "A&hit_limit=99", undefined, undefined]],
    ["-3", [undefined, undefined, undefined, "A&hit_limit=99", "A&hit_limit=99"]]
  ]) {
    const persistentStore = createPersistentStore();
    const values = {
      url: "https://example.com/api", target: "body", action: "set", hit_limit: limit, path: "$",
      value: "A&hit_limit=99", value_type: "string", delay_ms: "0"
    };
    const argument = template.replace(/\{\{\{(\w+)\}\}\}/g, (_, name) => values[name]);
    assert.deepEqual(expected.map(() => runScript({
      argument, moduleVersion: null, persistentStore
    }).result.body), expected);
  }
});

test("set accepts raw ampersands inside a JSON value", () => {
  const { result } = runScript({
    argument: 'target=body&action=set&path=data.value&value={"text":"A&B"}&value_type=json&delay_ms=0',
    body: JSON.stringify({ data: { value: null } })
  });
  assert.deepEqual(JSON.parse(result.body).data.value, { text: "A&B" });
});

test("value keeps embedded parameter-looking text before the final value_type", () => {
  const { result } = runScript({
    argument: "target=body&action=set&path=$&value=A&value_type=ignored&B=C&value_type=string&delay_ms=0"
  });
  assert.equal(result.body, "A&value_type=ignored&B=C");
});

test("value with no following value_type consumes the remaining argument text", () => {
  const { result } = runScript({
    argument: "target=body&action=set&path=$&value=A&B=C"
  });
  assert.equal(result.body, "A&B=C");
});

test("value without value_type still preserves a following delay option", () => {
  const { result, timers } = runScript({
    argument: "target=body&action=set&path=$&value=A&B=C&delay_ms=7"
  });
  assert.equal(result.body, "A&B=C");
  assert.deepEqual(timers, [7]);
});

test("@empty sets a JSON field to an empty string", () => {
  const { result } = runScript({
    argument:
      "target=body&action=set&path=data.version&value=@empty&value_type=string&delay_ms=0",
    body: JSON.stringify({ data: { version: "before" }, errorCode: "0" })
  });

  assert.deepEqual(JSON.parse(result.body), {
    data: { version: "" },
    errorCode: "0"
  });
});

test("path=$ replaces the whole body with JSON", () => {
  const { result } = runScript({
    argument:
      'target=body&action=set&path=$&value={"code":0,"data":null}&value_type=json&delay_ms=0',
    body: JSON.stringify({ old: true })
  });

  assert.equal(result.body, '{"code":0,"data":null}');
});

test("@empty forces empty-string semantics for a whole body", () => {
  const { result } = runScript({
    argument:
      "target=body&action=set&path=$&value=@empty&value_type=json&delay_ms=0",
    body: JSON.stringify({ old: true })
  });

  assert.equal(result.body, "");
});

test("@empty sets a header to an empty string", () => {
  const { result } = runScript({
    argument:
      "target=header&action=set&path=X-Debug&value=@empty&value_type=json&delay_ms=0",
    headers: { Existing: "yes" }
  });

  assert.equal(result.headers["X-Debug"], "");
});

test("@empty creates an empty mock response body", () => {
  const { result } = runScript({
    argument:
      "target=body&action=mock&path=$&value=@empty&value_type=json&delay_ms=0",
    direction: "request"
  });

  assert.equal(result.response.body, "");
  assert.deepEqual(Object.keys(result.response.headers), []);
});

test("action=remove rejects path=$ without modifying the response", () => {
  const originalBody = JSON.stringify({ data: { version: "before" } });
  const { result, logs } = runScript({
    argument:
      "target=body&action=remove&path=$&value=@empty&value_type=string&delay_ms=0",
    body: originalBody
  });

  assert.deepEqual(Object.keys(result), []);
  assert.ok(logs.some(message => message.includes("cannot remove the whole body")));
});

test("ordinary values and JSON paths keep their existing behavior", () => {
  const { result } = runScript({
    argument:
      "target=body&action=set&path=data.version&value=a&value_type=string&delay_ms=0",
    body: JSON.stringify({ data: { version: "before" } })
  });

  assert.deepEqual(JSON.parse(result.body), { data: { version: "a" } });
});

test("format can put text before, after, and around the old string", () => {
  for (const [template, expected] of [
    ["pre-${old}", "pre-original"],
    ["${old}-post", "original-post"],
    ["(${old})/${old}", "(original)/original"]
  ]) {
    const { result, logs } = runScript({
      argument: `target=body&action=format&path=data.version&value=${template}&value_type=string&delay_ms=0`,
      body: JSON.stringify({ data: { version: "original" } })
    });
    assert.equal(JSON.parse(result.body).data.version, expected);
    assert.ok(logs.some(message => message.includes(`data.version <- string(${expected})`)));
  }
});

test("format uses each filtered item's own old string", () => {
  const { result } = runScript({
    argument: "target=body&action=format&path=items[?(@.role == 0)].content&value=【${old}】&value_type=string&delay_ms=0",
    body: JSON.stringify({ items: [
      { role: 0, content: "one" },
      { role: 1, content: "keep" },
      { role: 0, content: "two" }
    ] })
  });
  assert.deepEqual(JSON.parse(result.body).items.map(item => item.content), ["【one】", "keep", "【two】"]);
});

test("set keeps ${old} literal and format leaves missing or non-string fields unchanged", () => {
  const body = JSON.stringify({ data: { text: "old", number: 7 } });
  const literal = runScript({
    argument: "target=body&action=set&path=data.text&value=${old}&value_type=string&delay_ms=0",
    body
  });
  assert.equal(JSON.parse(literal.result.body).data.text, "${old}");

  for (const pathText of ["data.missing", "data.number", "$"]) {
    const { result } = runScript({
      argument: `target=body&action=format&path=${pathText}&value=pre-\${old}&value_type=string&delay_ms=0`,
      body
    });
    assert.deepEqual(Object.keys(result), [], pathText);
  }
});

test("format rejects unsupported targets and value types without modifying data", () => {
  const body = JSON.stringify({ data: { text: "old" } });
  for (const argument of [
    "target=header&action=format&path=X-Debug&value=${old}-new&value_type=string&delay_ms=0",
    "target=body&action=format&path=data.text&value=${old}-new&value_type=json&delay_ms=0",
    "target=body&action=format&path=&value=${old}-new&value_type=string&delay_ms=0"
  ]) {
    const { result } = runScript({ argument, body, headers: { "X-Debug": "old" } });
    assert.deepEqual(Object.keys(result), [], argument);
  }
});

test("format skips filtered matches without an existing string field", () => {
  const { result } = runScript({
    argument: "target=body&action=format&path=items[?(@.role == 0)].content&value=pre-${old}&value_type=string&delay_ms=0",
    body: JSON.stringify({ items: [
      { role: 0, content: "one" }, { role: 0 }, { role: 0, content: null }
    ] })
  });
  assert.deepEqual(JSON.parse(result.body).items, [
    { role: 0, content: "pre-one" }, { role: 0 }, { role: 0, content: null }
  ]);
});

test("percent-escaped value delimiters are decoded while ordinary percent signs stay literal", () => {
  const encoded = runScript({
    argument: "target=body&action=format&path=data.text&value=${old}%26more%3Dyes&value_type=string&delay_ms=0",
    body: JSON.stringify({ data: { text: "before" } })
  });
  assert.equal(JSON.parse(encoded.result.body).data.text, "before&more=yes");

  const plain = runScript({
    argument: "target=body&action=set&path=$&value=100% ready&value_type=string&delay_ms=0"
  });
  assert.equal(plain.result.body, "100% ready");
});

test("base64: prefix is ordinary literal text in the new script", () => {
  const { result } = runScript({
    argument: "target=body&action=set&path=$&value=base64:SGVsbG8=&value_type=string&delay_ms=0"
  });
  assert.equal(result.body, "base64:SGVsbG8=");
});

test("an empty path still replaces the whole body for direct callers", () => {
  const { result } = runScript({
    argument:
      "target=body&action=set&path=&value=replaced&value_type=string&delay_ms=0",
    body: JSON.stringify({ old: true })
  });

  assert.equal(result.body, "replaced");
});

test("missing script arguments safely pass through without a module version", () => {
  const { result, logs } = runScript({ argument: undefined, moduleVersion: null });
  assert.deepEqual(Object.keys(result), []);
  assert.ok(logs.some(message => message.includes("version mismatch")));
});

test("script defaults apply when optional arguments are absent", () => {
  const { result } = runScript({
    argument: "path=$&value=plain",
    body: "before"
  });
  assert.equal(result.body, "plain");
});

test("missing value and extra malformed argument pairs do not corrupt parsing", () => {
  const empty = runScript({ argument: "path=$", body: "before" });
  assert.equal(empty.result.body, "");
  const extra = runScript({
    argument: "target=body&action=set&path=$&value=x&value_type=string&delay_ms=0&bare&&=ignored",
    body: "before"
  });
  assert.equal(extra.result.body, "x");
});

test("JSONPath filter changes every message with the selected createTime", () => {
  const body = JSON.stringify({
    data: {
      messageList: [
        { createTime: 1790168462709, content: "old-a" },
        { createTime: 12, content: "keep" },
        { createTime: 1790168462709, content: "old-b" }
      ]
    }
  });
  const { result } = runScript({
    argument:
      "target=body&action=set&path=data.messageList[?(@.createTime == 1790168462709)].content&value=changed&value_type=string&delay_ms=0",
    body
  });

  assert.deepEqual(JSON.parse(result.body).data.messageList.map(item => item.content), [
    "changed", "keep", "changed"
  ]);
});

test("JSONPath filter supports AND, OR, and grouping without splitting the argument", () => {
  const body = JSON.stringify({ data: { messageList: [
    { createTime: 7, role: 0, status: 0, content: "a" },
    { createTime: 7, role: 1, status: 0, content: "b" },
    { createTime: 8, role: 0, status: 1, content: "c" },
    { createTime: 8, role: 1, status: 0, content: "d" }
  ] } });
  const { result } = runScript({
    argument:
      "target=body&action=set&path=data.messageList[?((@.createTime == 7 && @.role == 0) || @.status == 1)].content&value=changed&value_type=string&delay_ms=0",
    body
  });

  assert.deepEqual(JSON.parse(result.body).data.messageList.map(item => item.content), [
    "changed", "b", "changed", "d"
  ]);
});

test("JSONPath filter compares strings and numbers without coercion", () => {
  const body = JSON.stringify({ data: { messageList: [
    { createTime: 7, content: "number" },
    { createTime: "7", content: "string" }
  ] } });
  const { result } = runScript({
    argument:
      "target=body&action=set&path=$.data.messageList[?(@.createTime == '7')].content&value=changed&value_type=string&delay_ms=0",
    body
  });

  assert.deepEqual(JSON.parse(result.body).data.messageList.map(item => item.content), [
    "number", "changed"
  ]);
});

test("JSONPath filter does not order booleans but includes equality in <=", () => {
  const body = JSON.stringify({ items: [
    { flag: false, content: "false" },
    { flag: true, content: "true" },
    { flag: null, content: "null" }
  ] });
  const lessThan = runScript({
    argument: "target=body&action=set&path=items[?(@.flag < true)].content&value=changed&value_type=string&delay_ms=0",
    body
  });
  assert.deepEqual(Object.keys(lessThan.result), []);

  const lessOrEqual = runScript({
    argument: "target=body&action=set&path=items[?(@.flag <= null)].content&value=changed&value_type=string&delay_ms=0",
    body
  });
  assert.deepEqual(JSON.parse(lessOrEqual.result.body).items.map(item => item.content), [
    "false", "true", "changed"
  ]);
});

test("JSONPath filter treats a missing field as unequal to a literal", () => {
  const body = JSON.stringify({ items: [
    { role: 0, content: "missing" },
    { role: 1, status: "ok", content: "present" }
  ] });
  const { result } = runScript({
    argument: "target=body&action=set&path=items[?(@.status != 'ok')].content&value=changed&value_type=string&delay_ms=0",
    body
  });
  assert.deepEqual(JSON.parse(result.body).items.map(item => item.content), [
    "changed", "present"
  ]);
});

test("JSONPath filter decodes Unicode escapes in quoted literals", () => {
  const body = JSON.stringify({ items: [{ name: "A", content: "old" }] });
  const { result } = runScript({
    argument: 'target=body&action=set&path=items[?(@.name == "\\u0041")].content&value=changed&value_type=string&delay_ms=0',
    body
  });
  assert.equal(JSON.parse(result.body).items[0].content, "changed");
});

test("JSONPath filter rejects malformed quoted-literal escapes", () => {
  const body = JSON.stringify({ items: [{ name: "q", content: "old" }] });
  const { result, logs } = runScript({
    argument: 'target=body&action=set&path=items[?(@.name == "\\q")].content&value=changed&value_type=string&delay_ms=0',
    body
  });
  assert.deepEqual(Object.keys(result), []);
  assert.ok(logs.some(message => message.includes("invalid JSON path")));
});

test("JSONPath filter keeps ampersands and closing brackets inside quoted literals", () => {
  const body = JSON.stringify({ items: [
    { name: "a&]b", content: "old" },
    { name: "other", content: "keep" }
  ] });
  const { result } = runScript({
    argument: "target=body&action=set&path=items[?(@.name == 'a&]b')].content&value=changed&value_type=string&delay_ms=0",
    body
  });
  assert.deepEqual(JSON.parse(result.body).items.map(item => item.content), ["changed", "keep"]);
});

test("JSONPath filter with no matches leaves the response untouched", () => {
  const body = JSON.stringify({ data: { messageList: [{ createTime: 7, content: "old" }] } });
  const { result, logs } = runScript({
    argument:
      "target=body&action=set&path=data.messageList[?(@.createTime == 8)].content&value=changed&value_type=string&delay_ms=0",
    body
  });

  assert.deepEqual(Object.keys(result), []);
  assert.ok(logs.some(message => message.includes("no matching")));
});

test("malformed JSONPath filter leaves the response untouched", () => {
  const body = JSON.stringify({ data: { messageList: [{ createTime: 7, content: "old" }] } });
  const { result, logs } = runScript({
    argument:
      "target=body&action=set&path=data.messageList[?(@.createTime == )].content&value=changed&value_type=string&delay_ms=0",
    body
  });

  assert.deepEqual(Object.keys(result), []);
  assert.ok(logs.some(message => message.includes("invalid JSON path")));
});

test("JSONPath filter removes a field from every matching object", () => {
  const body = JSON.stringify({ data: { messageList: [
    { role: 0, content: "a" },
    { role: 1, content: "b" },
    { role: 0, content: "c" }
  ] } });
  const { result } = runScript({
    argument:
      "target=body&action=remove&path=data.messageList[?(@.role == 0)].content&value=ignored&value_type=string&delay_ms=0",
    body
  });

  assert.deepEqual(JSON.parse(result.body).data.messageList, [
    { role: 0 }, { role: 1, content: "b" }, { role: 0 }
  ]);
});

test("JSONPath filter remove skips matched objects without the field", () => {
  const body = JSON.stringify({ items: [
    { role: 0, content: "a" },
    { role: 0 },
    { role: 1, content: "b" }
  ] });
  const { result } = runScript({
    argument:
      "target=body&action=remove&path=items[?(@.role == 0)].content&value=ignored&value_type=string&delay_ms=0",
    body
  });
  assert.deepEqual(JSON.parse(result.body).items, [
    { role: 0 }, { role: 0 }, { role: 1, content: "b" }
  ]);
});

test("filtered set skips matched objects without the nested parent", () => {
  const body = JSON.stringify({ items: [
    { role: 0, data: { content: "a" } },
    { role: 0 },
    { role: 1, data: { content: "b" } }
  ] });
  const { result } = runScript({
    argument:
      "target=body&action=set&path=items[?(@.role == 0)].data.content&value=changed&value_type=string&delay_ms=0",
    body
  });
  assert.deepEqual(JSON.parse(result.body).items, [
    { role: 0, data: { content: "changed" } },
    { role: 0 },
    { role: 1, data: { content: "b" } }
  ]);
});

test("filtered mutation with no writable suffix leaves the response untouched", () => {
  const body = JSON.stringify({ items: [{ role: 0 }] });
  for (const action of ["set", "remove"]) {
    const { result } = runScript({
      argument:
        `target=body&action=${action}&path=items[?(@.role == 0)].data.content&value=x&value_type=string&delay_ms=0`,
      body
    });
    assert.deepEqual(Object.keys(result), [], action);
  }
});

test("filtered set accepts @empty even when value_type is json", () => {
  const body = JSON.stringify({ items: [
    { role: 0, content: "a" },
    { role: 0, content: "b" },
    { role: 1, content: "c" }
  ] });
  const { result } = runScript({
    argument:
      "target=body&action=set&path=items[?(@.role == 0)].content&value=@empty&value_type=json&delay_ms=0",
    body
  });
  assert.deepEqual(JSON.parse(result.body).items.map(item => item.content), ["", "", "c"]);
});

test("ordinary values containing apostrophes keep following module arguments intact", () => {
  const { result } = runScript({
    argument:
      "target=body&action=set&path=data.message&value=it's fine&value_type=string&delay_ms=0",
    body: JSON.stringify({ data: { message: "old" } })
  });

  assert.deepEqual(JSON.parse(result.body), { data: { message: "it's fine" } });
});

test("Body set converts every supported value_type", () => {
  const cases = [
    ["string", "42", "42"],
    ["number", "42", 42],
    ["boolean", "true", true],
    ["boolean", "0", false],
    ["null", "ignored", null],
    ["json", '{"enabled":true}', { enabled: true }]
  ];
  for (const [valueType, value, expected] of cases) {
    const { result } = runScript({
      argument: `target=body&action=set&path=data.value&value=${value}&value_type=${valueType}&delay_ms=0`,
      body: JSON.stringify({ data: { value: "before" } })
    });
    assert.deepEqual(JSON.parse(result.body).data.value, expected, valueType);
  }
});

test("setting a JSON array field preserves the array value", () => {
  const { result, logs } = runScript({
    argument: "target=body&action=set&path=data.value&value=[1,2]&value_type=json&delay_ms=0",
    body: JSON.stringify({ data: { value: "before" } })
  });
  assert.deepEqual(JSON.parse(result.body).data.value, [1, 2]);
  assert.ok(logs.some(message => message.includes("Array(2)")));
});

test("Body set and remove support array index paths", () => {
  const body = JSON.stringify({ data: { items: ["a", "b", "c"] } });
  const set = runScript({
    argument: "target=body&action=set&path=data.items[1]&value=x&value_type=string&delay_ms=0",
    body
  });
  assert.deepEqual(JSON.parse(set.result.body).data.items, ["a", "x", "c"]);

  const remove = runScript({
    argument: "target=body&action=remove&path=data.items[1]&value=ignored&value_type=string&delay_ms=0",
    body
  });
  assert.deepEqual(JSON.parse(remove.result.body).data.items, ["a", "c"]);
});

test("malformed ordinary Body paths never modify a valid field", () => {
  const body = JSON.stringify({ data: { version: "before", items: [{ x: "before" }] } });
  for (const badPath of [
    "data..version", "data.version.", "data[version]", "data.items[0]x", "data.items.[0]"
  ]) {
    const { result } = runScript({
      argument: `target=body&action=set&path=${badPath}&value=changed&value_type=string&delay_ms=0`,
      body
    });
    assert.deepEqual(Object.keys(result), [], badPath);
  }
});

test("out-of-range and negative Body array indexes leave the response untouched", () => {
  const body = JSON.stringify({ data: { items: ["a"] } });
  for (const badPath of [
    "data.items[4]", "data.items[-1]", "data.items.4",
    "data.items.01", "data.items.length", "data.items.foo"
  ]) {
    const { result } = runScript({
      argument: `target=body&action=set&path=${badPath}&value=x&value_type=string&delay_ms=0`,
      body
    });
    assert.deepEqual(Object.keys(result), [], badPath);
  }
});

test("array pseudo-properties cannot be set or removed", () => {
  const body = JSON.stringify({ data: { items: ["a", "b", "c"] } });
  for (const action of ["set", "remove"]) {
    for (const badPath of ["data.items.length", "data.items.foo"]) {
      const { result } = runScript({
        argument: `target=body&action=${action}&path=${badPath}&value=0&value_type=number&delay_ms=0`,
        body
      });
      assert.deepEqual(Object.keys(result), [], `${action} ${badPath}`);
    }
  }
});

test("array items require bracket indexes in intermediate and filtered paths", () => {
  const body = JSON.stringify({
    data: { items: [{ content: "keep" }] },
    items: [{ role: 0, values: ["a", "b"] }]
  });
  for (const badPath of [
    "data.items.0.content",
    "items[?(@.role == 0)].values.length",
    "items[?(@.role == 0)].values.4"
  ]) {
    const { result } = runScript({
      argument: `target=body&action=set&path=${badPath}&value=0&value_type=number&delay_ms=0`,
      body
    });
    assert.deepEqual(Object.keys(result), [], badPath);
  }
});

test("filtered path prefixes also require bracket array indexes", () => {
  const body = JSON.stringify({ data: { groups: [[{ role: 0, content: "keep" }]] } });
  const { result } = runScript({
    argument: "target=body&action=set&path=data.groups.0[?(@.role == 0)].content&value=changed&value_type=string&delay_ms=0",
    body
  });
  assert.deepEqual(Object.keys(result), []);
});

test("Body mutations work for request bodies too", () => {
  const { result } = runScript({
    direction: "request",
    argument: "target=body&action=set&path=data.value&value=changed&value_type=string&delay_ms=0",
    body: JSON.stringify({ data: { value: "before" } })
  });
  assert.equal(JSON.parse(result.body).data.value, "changed");
});

test("whole-body replacement serializes supported types", () => {
  const cases = [
    ["string", "text", "text"],
    ["number", "42", "42"],
    ["boolean", "false", "false"],
    ["null", "ignored", "null"],
    ["json", '[1,2]', "[1,2]"]
  ];
  for (const [type, value, expected] of cases) {
    const { result } = runScript({
      argument: `target=body&action=set&path=$&value=${value}&value_type=${type}&delay_ms=0`,
      body: "before"
    });
    assert.equal(result.body, expected, type);
  }
});

test("invalid Body values and absent JSON paths pass through", () => {
  const body = JSON.stringify({ data: { value: "before" } });
  const cases = [
    "target=body&action=set&path=data.value&value=oops&value_type=number&delay_ms=0",
    "target=body&action=set&path=data.value&value=maybe&value_type=boolean&delay_ms=0",
    "target=body&action=set&path=data.value&value={bad}&value_type=json&delay_ms=0",
    "target=body&action=set&path=data.value&value=x&value_type=unsupported&delay_ms=0",
    "target=body&action=set&path=missing.value&value=x&value_type=string&delay_ms=0",
    "target=body&action=remove&path=data.missing&value=x&value_type=string&delay_ms=0",
    "target=body&action=remove&path=&value=x&value_type=string&delay_ms=0"
  ];
  for (const argument of cases) {
    assert.deepEqual(Object.keys(runScript({ argument, body }).result), [], argument);
  }
  for (const invalidBody of ["not-json", null]) {
    const { result } = runScript({
      argument: "target=body&action=set&path=data.value&value=x&value_type=string&delay_ms=0",
      body: invalidBody
    });
    assert.deepEqual(Object.keys(result), []);
  }
});

test("remove with malformed paths or unavailable bodies passes through", () => {
  const body = JSON.stringify({ data: { version: "before" } });
  for (const [pathText, responseBody] of [
    ["data..version", body],
    ["data.version", null],
    ["data.version", "not-json"]
  ]) {
    const { result } = runScript({
      argument: `target=body&action=remove&path=${pathText}&value=ignored&value_type=string&delay_ms=0`,
      body: responseBody
    });
    assert.deepEqual(Object.keys(result), [], pathText);
  }
});

test("setting below a primitive JSON value passes through", () => {
  const { result } = runScript({
    argument: "target=body&action=set&path=data.version.child&value=x&value_type=string&delay_ms=0",
    body: JSON.stringify({ data: { version: "before" } })
  });
  assert.deepEqual(Object.keys(result), []);
});

test("Header set and remove are case-insensitive for object and array representations", () => {
  const cases = [
    [{ "X-Debug": "old", Keep: "yes" }, { "x-debug": "new", Keep: "yes" }, { Keep: "yes" }],
    [[{ field: "X-Debug", value: "old" }, { field: "Keep", value: "yes" }],
      [{ field: "Keep", value: "yes" }, { field: "x-debug", value: "new" }],
      [{ field: "Keep", value: "yes" }]]
  ];
  for (const [headers, expectedSet, expectedRemove] of cases) {
    const set = runScript({
      argument: "target=header&action=set&path=x-debug&value=new&value_type=string&delay_ms=0",
      headers
    });
    assert.deepEqual(JSON.parse(JSON.stringify(set.result.headers)), expectedSet);
    const remove = runScript({
      argument: "target=header&action=remove&path=x-debug&value=ignored&value_type=string&delay_ms=0",
      headers
    });
    assert.deepEqual(JSON.parse(JSON.stringify(remove.result.headers)), expectedRemove);
  }
  assert.deepEqual(Object.keys(runScript({
    argument: "target=header&action=set&path=&value=x&value_type=string&delay_ms=0"
  }).result), []);
});

test("Header set starts from an empty map when packet headers are unavailable", () => {
  const { result } = runScript({
    direction: "request",
    headers: null,
    argument: "target=header&action=set&path=X-Debug&value=yes&value_type=string&delay_ms=0"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.headers)), { "X-Debug": "yes" });
});

test("URL changes only request URLs with action=set and a nonempty value", () => {
  const argument = "target=url&action=set&path=&value=https://example.com/new&value_type=string&delay_ms=0";
  assert.equal(runScript({ argument, direction: "request" }).result.url, "https://example.com/new");
  assert.deepEqual(Object.keys(runScript({ argument, direction: "response" }).result), []);
  assert.deepEqual(Object.keys(runScript({
    argument: "target=url&action=remove&path=&value=https://example.com/new&value_type=string&delay_ms=0",
    direction: "request"
  }).result), []);
  assert.deepEqual(Object.keys(runScript({
    argument: "target=url&action=set&path=&value=@empty&value_type=string&delay_ms=0",
    direction: "request"
  }).result), []);
});

test("Status changes only responses and accepts HTTP status integers from 100 to 999", () => {
  for (const status of [100, 204, 999]) {
    const { result } = runScript({
      argument: `target=status&action=set&path=&value=${status}&value_type=number&delay_ms=0`
    });
    assert.equal(result.status, status);
  }
  for (const value of ["99", "1000", "200.5", "oops", "@empty"]) {
    const { result } = runScript({
      argument: `target=status&action=set&path=&value=${value}&value_type=string&delay_ms=0`
    });
    assert.deepEqual(Object.keys(result), [], value);
  }
  assert.deepEqual(Object.keys(runScript({
    argument: "target=status&action=set&path=&value=200&value_type=number&delay_ms=0",
    direction: "request"
  }).result), []);
  assert.deepEqual(Object.keys(runScript({
    argument: "target=status&action=remove&path=&value=200&value_type=number&delay_ms=0"
  }).result), []);
});

test("Mock returns HTTP 200, serializes JSON, and is request-only", () => {
  const mock = runScript({
    argument: 'target=body&action=mock&path=$&value={"ok":true}&value_type=json&delay_ms=0',
    direction: "request"
  });
  assert.deepEqual(JSON.parse(JSON.stringify(mock.result.response)), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: '{"ok":true}'
  });
  assert.deepEqual(Object.keys(runScript({
    argument: "target=body&action=mock&path=$&value=x&value_type=string&delay_ms=0",
    direction: "response"
  }).result), []);
});

test("Abort works in both directions; unsupported action or target passes through", () => {
  for (const direction of ["request", "response"]) {
    const { result } = runScript({
      argument: "target=body&action=abort&path=&value=&value_type=string&delay_ms=0",
      direction
    });
    assert.equal(result.abort, true);
  }
  for (const argument of [
    "target=body&action=unknown&path=&value=x&value_type=string&delay_ms=0",
    "target=unknown&action=set&path=&value=x&value_type=string&delay_ms=0"
  ]) {
    assert.deepEqual(Object.keys(runScript({ argument }).result), []);
  }
});


test("delay_ms applies and is clamped to the 0–25000 ms range", () => {
  for (const [configured, expected] of [["25", 25], ["99999", 25000], ["-1", null], ["oops", null]]) {
    const { result, timers } = runScript({
      argument: `target=body&action=set&path=$&value=x&value_type=string&delay_ms=${configured}`
    });
    assert.equal(result.body, "x");
    assert.deepEqual(timers, expected == null ? [] : [expected]);
  }
});

test("filtered Body set supports typed values and nested condition fields", () => {
  const body = JSON.stringify({ items: [
    { meta: { code: 1 }, content: "old" },
    { meta: { code: 2 }, content: "keep" }
  ] });
  const { result } = runScript({
    argument: 'target=body&action=set&path=items[?(@.meta.code >= 1 && @.meta.code < 2)].content&value={"ok":true}&value_type=json&delay_ms=0',
    body
  });
  assert.deepEqual(JSON.parse(result.body).items.map(item => item.content), [
    { ok: true }, "keep"
  ]);
});

test("filtering a root array works without a path prefix", () => {
  const { result } = runScript({
    argument: "target=body&action=set&path=[?(@.role == 0)].content&value=changed&value_type=string&delay_ms=0",
    body: JSON.stringify([{ role: 0, content: "a" }, { role: 1, content: "b" }])
  });
  assert.deepEqual(JSON.parse(result.body).map(item => item.content), ["changed", "b"]);
});

test("filtered paths pass through for absent or non-array prefixes", () => {
  const body = JSON.stringify({ data: { items: [] } });
  for (const pathText of ["missing[?(@.role == 0)].content", "data[?(@.role == 0)].content"]) {
    const { result } = runScript({
      argument: `target=body&action=set&path=${pathText}&value=x&value_type=string&delay_ms=0`,
      body
    });
    assert.deepEqual(Object.keys(result), [], pathText);
  }
});

test("malformed filtered paths never change the response", () => {
  const body = JSON.stringify({ items: [{ role: 0, content: "old" }] });
  const invalidPaths = [
    "items[?(@.role == 0)]",
    "items[?(@.role == 0)][?(@.role == 0)].content",
    "items[?(@.role == 0)].",
    "items[?(@.role == 0)].content.",
    ".items[?(@.role == 0)].content",
    "items[?(@.role 0)].content",
    "items[?(@ == 0)].content",
    "items[?(@. == 0)].content",
    "items[?(@.role == 0 junk)].content",
    'items[?(@.role == "\\u12")].content'
  ];
  for (const pathText of invalidPaths) {
    const { result, logs } = runScript({
      argument: `target=body&action=set&path=${pathText}&value=x&value_type=string&delay_ms=0`,
      body
    });
    assert.deepEqual(Object.keys(result), [], pathText);
    assert.ok(logs.some(message => message.includes("invalid JSON path")), pathText);
  }
});

test("unterminated filter strings pass through even with a valid module version", () => {
  const body = JSON.stringify({ items: [{ name: "a", content: "old" }] });
  for (const expression of ['@.name == "a', '@.name == "a\\']) {
    const { result, logs } = runScript({
      argument:
        `module_version=${CURRENT_VERSION}&target=body&action=set&value=x&value_type=string&delay_ms=0&path=items[?(${expression})].content`,
      moduleVersion: null,
      body
    });
    assert.deepEqual(Object.keys(result), [], expression);
    assert.ok(logs.some(message => message.includes("invalid JSON path")), expression);
  }
});

test("filtered comparisons cover each numeric ordering and inequality operator", () => {
  const body = JSON.stringify({ items: [
    { score: 1, content: "one" },
    { score: 2, content: "two" },
    { score: 3, content: "three" }
  ] });
  const cases = [
    ["<", ["changed", "two", "three"]],
    ["<=", ["changed", "changed", "three"]],
    [">", ["one", "two", "changed"]],
    [">=", ["one", "changed", "changed"]],
    ["!=", ["changed", "two", "changed"]]
  ];
  for (const [operator, expected] of cases) {
    const { result } = runScript({
      argument: `target=body&action=set&path=items[?(@.score ${operator} 2)].content&value=changed&value_type=string&delay_ms=0`,
      body
    });
    assert.deepEqual(JSON.parse(result.body).items.map(item => item.content), expected, operator);
  }
});

test("filtered string comparisons decode standard short escapes", () => {
  for (const [literal, name] of [["a\\nb", "a\nb"], ["a\\'b", "a'b"]]) {
    const { result } = runScript({
      argument: `target=body&action=set&path=items[?(@.name == '${literal}')].content&value=changed&value_type=string&delay_ms=0`,
      body: JSON.stringify({ items: [{ name, content: "old" }] })
    });
    assert.equal(JSON.parse(result.body).items[0].content, "changed");
  }
});
