/**
 * surge_api_debug.js
 *
 * 通用 Surge API 调试 / 故障注入脚本。
 * Script Version: 1.0.0
 *
 * Module 参数：
 *   url         由 Module 的 pattern 匹配，按完整正则与方向分别计数和重置
 *   direction   request / response，由 type=http-{{{direction}}} 决定
 *   target      body / header / url / status
 *   action      set / format / remove / mock / abort
 *   path        target 内的具体位置；target=body 时 $ 表示整个 Body
 *               数组可用 [?(@.field == value)] 筛选，匹配项会全部修改
 *   value       新值；@empty 表示空字符串；format 时 ${old} 表示字段原值
 *   value_type  string / number / boolean / null / json
 *   hit_limit   0 或留空：不限；N：前 N 次；-N：跳过前 N 次
 *   delay_ms    额外延迟，0~25000 ms
 *
 * 约定：
 *   - target=body + path 非空：修改 JSON Body 指定字段
 *   - action=format：仅 Body 字符串字段，按 ${old} 格式化原值
 *   - target=body + path=$ 或 path 为空：替换整个 Body
 *   - target=header：path 表示 Header 名
 *   - target=url：仅 request + set
 *   - target=status：仅 response + set
 *   - action=mock：仅 request，直接返回 HTTP 200 Mock Response
 *   - action=abort：request/response 均可，忽略 target/path/value
 *
 * value 传输：
 *   value=hello
 *   value=A&B（value_type 之前的 & 属于 value）
 *   value=@empty
 *   value=%26 表示 & 等分隔字符（百分号转义）
 *
 * @empty 固定表示空字符串；value 先按百分号转义解码，再按 value_type 转换。
 */

const PREFIX = "[Surge API Debug]";
const SCRIPT_VERSION = "1.0.0";

const args = parseArguments(
  typeof $argument === "string" ? $argument : ""
);

const isResponse =
  typeof $response !== "undefined" && $response !== null;

const request = typeof $request === "undefined" ? null : $request;
const packet = isResponse ? $response : request;
const direction = isResponse ? "response" : "request";

const target = args.target || "body";
const action = args.action || "set";
const path = args.path || "";
const moduleVersion = args.module_version || "";
const panelScope = target === "reset" ? readPanelScope() : null;
const urlPattern = panelScope ? panelScope.urlPattern : (args.url_pattern || "");
const hitStore = typeof $persistentStore === "undefined" ? null : $persistentStore;
const hitLimitText = (panelScope ? panelScope.hitLimitText : args.hit_limit)?.trim() || "";
const hitLimit = !hitLimitText || /^[+-]?\d+$/.test(hitLimitText)
  ? Number(hitLimitText)
  : NaN;
let valueType = args.value_type || "string";
const delayMs = clamp(
  Math.floor(toNumber(args.delay_ms, 0)),
  0,
  25000
);

let rawValue =
  Object.prototype.hasOwnProperty.call(args, "value")
    ? args.value
    : "";

main();

function main() {
  try {
    if (moduleVersion !== SCRIPT_VERSION) {
      log(
        `version mismatch: script=${SCRIPT_VERSION}, ` +
        `module=${moduleVersion || "missing"}; passthrough; 请更新配套的 Module 和 JS`, "配置错误"
      );
      return finish({});
    }

    log(
      `script_version=${SCRIPT_VERSION}, ` +
      `module_version=${moduleVersion}`
    );

    if (target === "reset") return handleResetPanel();

    if (!Number.isSafeInteger(hitLimit)) {
      return invalid("hit_limit must be an integer", "hit_limit=0、3 或 -3");
    }

    if (rawValue === "@empty") {
      rawValue = "";
      valueType = "string";
    } else {
      rawValue = decodeURIComponentSafe(rawValue);
    }

    log(
      `direction=${direction}, target=${target}, action=${action}` +
      (path ? `, path=${path}` : "")
    );

    if (action === "abort") {
      return applyHit({ abort: true }, "abort connection");
    }

    if (action === "mock") {
      return handleMock();
    }

    if (action !== "set" && action !== "format" && action !== "remove") {
      return invalid(`unsupported action: ${action}`, "action=set/format/remove/mock/abort");
    }

    if (action === "format" && target !== "body") {
      return invalid("action=format only supports target=body");
    }

    switch (target) {
      case "body":
        return handleBody();

      case "header":
        return handleHeader();

      case "url":
        return handleUrl();

      case "status":
        return handleStatus();

      default:
        return invalid(`unsupported target: ${target}`, "target=body/header/url/status");
    }
  } catch (error) {
    log(
      `error: ${
        error && error.stack ? error.stack : String(error)
      }`, error?.name === "ConfigurationError" ? "配置错误" : "执行错误"
    );
    return finish({});
  }
}

// ---------------------------------------------------------------------------
// body
// ---------------------------------------------------------------------------

function handleBody() {
  if (action === "remove") {
    if (path === "$") {
      return invalid(
        "action=remove cannot remove the whole body"
      );
    }

    if (!path) {
      return invalid(
        "target=body + action=remove requires path"
      );
    }

    const json = parseBodyJson();
    if (!json.ok) return finish({});

    if (path.includes("[?")) {
      return handleFilteredBody(json.value);
    }

    const tokens = parsePath(path);
    if (!tokens.length) {
      return invalid(`invalid JSON path: ${path}`);
    }

    const result = removeAtPath(json.value, tokens);
    if (!result.ok) {
      log(result.message, "已跳过");
      return finish({});
    }

    return applyHit({ body: JSON.stringify(json.value) }, `removed body field: ${path}`);
  }

  if (action === "format" && (!path || path === "$" || valueType !== "string")) {
    return invalid("action=format requires a Body field path and value_type=string");
  }

  const value = action === "format" ? rawValue : parseTypedValue(rawValue, valueType);

  // path=$ 为 Module 显式根路径；空 path 保留给直接调用者兼容使用
  if (!path || path === "$") {
    const body = serializeWholeBody(value, valueType);

    return applyHit(
      { body },
      `replace whole ${direction} body, length=${unicodeLength(body)}`
    );
  }

  // path 非空时，按 JSON Path 修改字段
  const json = parseBodyJson();
  if (!json.ok) return finish({});

  if (path.includes("[?")) {
    return handleFilteredBody(json.value, value);
  }

  const tokens = parsePath(path);
  if (!tokens.length) {
    return invalid(`invalid JSON path: ${path}`);
  }

  const result = action === "format"
    ? formatAtPath(json.value, tokens, value)
    : setAtPath(json.value, tokens, value);
  if (!result.ok) {
    log(result.message, "已跳过");
    return finish({});
  }

  return applyHit(
    { body: JSON.stringify(json.value) },
    `${path} <- ${describeValue(action === "format" ? result.value : value)}`
  );
}

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------

function handleHeader() {
  if (!path) {
    return invalid(
      "target=header requires path as the Header name"
    );
  }

  const headers = copyHeaders(packet?.headers);

  if (action === "remove") {
    if (!removeHeader(headers, path)) {
      log(`header not found: ${path}; Header 不存在，本次不计数`, "已跳过");
      return finish(hitLimit === 0 ? { headers } : {});
    }
    return applyHit({ headers }, `removed header: ${path}`);
  }

  setHeader(headers, path, rawValue);
  return applyHit({ headers }, `header ${path} <- ${rawValue}`);
}

// ---------------------------------------------------------------------------
// url
// ---------------------------------------------------------------------------

function handleUrl() {
  if (direction !== "request") {
    return invalid(
      "target=url is only supported for direction=request"
    );
  }

  if (action !== "set") {
    return invalid(
      "target=url only supports action=set"
    );
  }

  if (!rawValue) {
    return invalid(
      "target=url + action=set requires value"
    );
  }

  return applyHit({ url: rawValue }, `request url -> ${rawValue}`);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function handleStatus() {
  if (direction !== "response") {
    return invalid(
      "target=status is only supported for direction=response"
    );
  }

  if (action !== "set") {
    return invalid(
      "target=status only supports action=set"
    );
  }

  const status = Number(rawValue);

  if (
    !Number.isInteger(status) ||
    status < 100 ||
    status > 999
  ) {
    return invalid(
      `invalid HTTP status value: ${rawValue}`
    );
  }

  return applyHit({ status }, `HTTP status -> ${status}`);
}

// ---------------------------------------------------------------------------
// mock
// ---------------------------------------------------------------------------

function handleMock() {
  if (direction !== "request") {
    return invalid(
      "action=mock is only supported for direction=request"
    );
  }

  const value = parseTypedValue(rawValue, valueType);
  const body = serializeWholeBody(value, valueType);
  const headers = {};

  if (valueType === "json") {
    headers["Content-Type"] =
      "application/json; charset=utf-8";
  }

  return applyHit(
    { response: { status: 200, headers, body } },
    `mock response: HTTP 200, body length=${unicodeLength(body)}`
  );
}

// ---------------------------------------------------------------------------
// Body JSON
// ---------------------------------------------------------------------------

function parseBodyJson() {
  const body = getBodyString();

  if (body == null) {
    log(
      "body unavailable; confirm requires-body=true and the body is text; 请检查 requires-body 和 Body 内容", "已跳过"
    );
    return { ok: false };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(body)
    };
  } catch (error) {
    log(`body is not valid JSON: ${error}; 接口 Body 不是有效 JSON，保持原样`, "已跳过");
    return { ok: false };
  }
}

function serializeWholeBody(value, type) {
  if (type === "json") {
    return JSON.stringify(value);
  }

  if (type === "null") {
    return "null";
  }

  if (type === "string") {
    return value;
  }

  return String(value);
}

// ---------------------------------------------------------------------------
// JSON Path
// ---------------------------------------------------------------------------

function parsePath(input) {
  try {
    return parseSimplePath(input, false);
  } catch (error) {
    log(`invalid JSON path: ${error.message}; 示例：data.name 或 items[0].name`, "配置错误");
    return [];
  }
}

function handleFilteredBody(root, value) {
  let selection;
  try {
    selection = parseFilteredPath(path);
  } catch (error) {
    return invalid(`invalid JSON path: ${error.message}`);
  }

  let current = root;
  for (const token of selection.prefix) {
    if (Array.isArray(current) && typeof token !== "number") {
      return invalid(`array index must use [n]: ${path}`);
    }
    if (current == null || !Object.prototype.hasOwnProperty.call(current, token)) {
      log(`no matching JSON path: ${path}; filter parent path not found，筛选数组的父路径不存在`, "已跳过");
      return finish({});
    }
    current = current[token];
  }

  if (!Array.isArray(current)) {
    return invalid(`invalid JSON path: filter target is not an array: ${path}`);
  }

  const matched = current.filter(item => matchesFilter(selection.expression, item));
  if (!matched.length) {
    log(`no matching JSON path: ${path}; filter matched 0 item(s)，筛选条件未命中`, "已跳过");
    return finish({});
  }

  let changed = 0;
  const skippedReasons = new Set();
  for (const item of matched) {
    const result = action === "remove"
      ? removeAtPath(item, selection.suffix)
      : action === "format"
        ? formatAtPath(item, selection.suffix, value)
        : setAtPath(item, selection.suffix, value);
    if (!result.ok) {
      // Selected objects can have different shapes. A missing suffix in one
      // object must not prevent changes to the other selected objects.
      skippedReasons.add(result.message);
      continue;
    }
    changed++;
  }

  if (!changed) {
    log(`no matching JSON path: ${path}; matched=${matched.length}, changed=0, skipped=${matched.length}; ${[...skippedReasons].join("; ")}`, "已跳过");
    return finish({});
  }
  return applyHit(
    { body: JSON.stringify(root) },
    `${path} ${action === "remove" ? "removed from" : "set on"} ${changed} item(s); ` +
    `matched=${matched.length}, changed=${changed}, skipped=${matched.length - changed}` +
    (skippedReasons.size ? `; 跳过原因：${[...skippedReasons].join("; ")}` : "")
  );
}

function parseFilteredPath(input) {
  const start = input.indexOf("[?");
  let end = -1;
  let quote = "";
  let escaped = false;
  for (let i = start + 2; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "]") {
      end = i;
      break;
    }
  }
  if (end < 0 || input[end + 1] !== "." || input.includes("[?", end + 1)) {
    throw new Error("filter must be followed by a field path");
  }
  const prefixText = input.slice(0, start).replace(/^\$\.?/, "");
  const suffixText = input.slice(end + 2);
  return {
    prefix: parseSimplePath(prefixText, true),
    expression: parseFilterExpression(input.slice(start + 2, end)),
    suffix: parseSimplePath(suffixText, false)
  };
}

function parseSimplePath(input, allowEmpty) {
  if (!input && allowEmpty) return [];
  const tokens = [];
  let position = 0;
  while (position < input.length) {
    if (input[position] === "[") {
      const match = /^\[(\d+)\]/.exec(input.slice(position));
      if (!match) throw new Error(`unsupported path segment: ${input.slice(position)}`);
      tokens.push(Number(match[1]));
      position += match[0].length;
    } else {
      const match = /^[^.[\]]+/.exec(input.slice(position));
      if (!match) throw new Error(`invalid path segment: ${input.slice(position)}`);
      tokens.push(match[0]);
      position += match[0].length;
    }
    if (position < input.length && input[position] === ".") {
      position++;
      if (position === input.length) throw new Error("trailing dot in path");
      if (input[position] === "[") throw new Error("dot cannot precede an index");
    } else if (position < input.length && input[position] !== "[") {
      throw new Error(`invalid path segment: ${input.slice(position)}`);
    }
  }
  if (!tokens.length) throw new Error("empty path segment");
  return tokens;
}

function parseFilterExpression(input) {
  let position = 0;
  const skipSpace = () => { while (/\s/.test(input[position] || "")) position++; };
  const consume = value => {
    skipSpace();
    if (input.startsWith(value, position)) { position += value.length; return true; }
    return false;
  };
  const requireToken = value => {
    if (!consume(value)) throw new Error(`expected ${value} in filter`);
  };
  const parseReference = () => {
    requireToken("@");
    const keys = [];
    while (consume(".")) {
      const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(input.slice(position));
      if (!match) throw new Error("expected field name in filter");
      keys.push(match[0]);
      position += match[0].length;
    }
    if (!keys.length) throw new Error("expected @.field in filter");
    return keys;
  };
  const parseLiteral = () => {
    skipSpace();
    const quote = input[position];
    if (quote === "'" || quote === '"') {
      position++;
      let value = "";
      while (position < input.length) {
        const char = input[position++];
        if (char === quote) return value;
        if (char === "\\") {
          if (position === input.length) throw new Error("invalid string escape in filter");
          const next = input[position++];
          const escapes = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          if (next === "u") {
            const digits = input.slice(position, position + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
              throw new Error("invalid Unicode escape in filter");
            }
            value += String.fromCharCode(parseInt(digits, 16));
            position += 4;
          } else if (Object.prototype.hasOwnProperty.call(escapes, next)) {
            value += escapes[next];
          } else if (next === "\\" || next === "/" || next === "'" || next === '"') {
            value += next;
          } else {
            throw new Error("invalid string escape in filter");
          }
        } else value += char;
      }
      throw new Error("unterminated string in filter");
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|^(?:true|false|null)\b/.exec(input.slice(position));
    if (!match) throw new Error("expected JSON literal in filter");
    position += match[0].length;
    return JSON.parse(match[0]);
  };
  const parseComparison = () => {
    const keys = parseReference();
    skipSpace();
    const operator = ["==", "!=", "<=", ">=", "<", ">"].find(op => input.startsWith(op, position));
    if (!operator) throw new Error("expected comparison operator in filter");
    position += operator.length;
    return { type: "compare", keys, operator, value: parseLiteral() };
  };
  const parsePrimary = () => {
    if (consume("(")) {
      const expression = parseOr();
      requireToken(")");
      return expression;
    }
    return parseComparison();
  };
  const parseAnd = () => {
    let left = parsePrimary();
    while (consume("&&")) left = { type: "and", left, right: parsePrimary() };
    return left;
  };
  const parseOr = () => {
    let left = parseAnd();
    while (consume("||")) left = { type: "or", left, right: parseAnd() };
    return left;
  };
  const expression = parseOr();
  skipSpace();
  if (position !== input.length) throw new Error(`unexpected filter text: ${input.slice(position)}`);
  return expression;
}

function matchesFilter(expression, item) {
  if (expression.type === "and") {
    return matchesFilter(expression.left, item) && matchesFilter(expression.right, item);
  }
  if (expression.type === "or") {
    return matchesFilter(expression.left, item) || matchesFilter(expression.right, item);
  }
  let current = item;
  for (const key of expression.keys) {
    if (current == null || !Object.prototype.hasOwnProperty.call(current, key)) {
      return expression.operator === "!=";
    }
    current = current[key];
  }
  const value = expression.value;
  const canOrder =
    (typeof current === "number" && typeof value === "number") ||
    (typeof current === "string" && typeof value === "string");
  switch (expression.operator) {
    case "==": return current === value;
    case "!=": return current !== value;
    case "<": return canOrder && current < value;
    case "<=": return current === value || (canOrder && current < value);
    case ">": return canOrder && current > value;
    case ">=": return current === value || (canOrder && current > value);
    default: return false;
  }
}

function getParent(root, tokens) {
  if (!tokens.length) {
    return {
      ok: false,
      message: "empty JSON path"
    };
  }

  let current = root;

  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];

    if (Array.isArray(current) && typeof token !== "number") {
      return { ok: false, message: `array index must use [n]: ${path}` };
    }

    if (
      current == null ||
      !Object.prototype.hasOwnProperty.call(
        current,
        token
      )
    ) {
      return {
        ok: false,
        message:
          `parent path not found: ` +
          `${tokens.slice(0, i + 1).join(".")}`
      };
    }

    current = current[token];
  }

  if (Array.isArray(current) && typeof tokens[tokens.length - 1] !== "number") {
    return { ok: false, message: `array index must use [n]: ${path}` };
  }

  return {
    ok: true,
    parent: current,
    key: tokens[tokens.length - 1]
  };
}

function setAtPath(root, tokens, value) {
  const result = getParent(root, tokens);

  if (!result.ok) return result;

  if (
    result.parent == null ||
    typeof result.parent !== "object"
  ) {
    return {
      ok: false,
      message: `parent is not writable: ${path}`
    };
  }

  if (
    Array.isArray(result.parent) &&
    typeof result.key === "number" &&
    result.key >= result.parent.length
  ) {
    return {
      ok: false,
      message: `array index out of range: ${path}`
    };
  }

  result.parent[result.key] = value;

  return { ok: true };
}

function formatAtPath(root, tokens, template) {
  const result = getParent(root, tokens);
  if (!result.ok) return result;

  const { parent, key } = result;
  if (parent == null || !Object.prototype.hasOwnProperty.call(parent, key) ||
      typeof parent[key] !== "string") {
    return { ok: false, message: `path is not an existing string field: ${path}` };
  }

  const formatted = template.replace(/\$\{old\}/g, () => parent[key]);
  const write = setAtPath(root, tokens, formatted);
  return write.ok ? { ok: true, value: formatted } : write;
}

function removeAtPath(root, tokens) {
  const result = getParent(root, tokens);

  if (!result.ok) return result;

  const { parent, key } = result;

  if (
    parent == null ||
    !Object.prototype.hasOwnProperty.call(parent, key)
  ) {
    return {
      ok: false,
      message: `path not found: ${path}`
    };
  }

  if (
    Array.isArray(parent) &&
    typeof key === "number"
  ) {
    parent.splice(key, 1);
  } else {
    delete parent[key];
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// value
// ---------------------------------------------------------------------------

function decodeURIComponentSafe(value) {
  // Decode each encoded run once. A literal '%' must not block other valid
  // escapes, and malformed UTF-8 is preserved rather than replaced or dropped.
  return value.replace(/(?:%[0-9a-f]{2})+/gi, encoded => {
    try { return decodeURIComponent(encoded); }
    catch (_) { return encoded; }
  });
}

function parseTypedValue(value, type) {
  switch (type) {
    case "string":
      return value;

    case "number": {
      const number = Number(value);

      if (!Number.isFinite(number)) {
        throw invalidValue(
          `invalid number value: ${value}; 示例：value=123&value_type=number`
        );
      }

      return number;
    }

    case "boolean":
      if (value === "true" || value === "1") {
        return true;
      }

      if (value === "false" || value === "0") {
        return false;
      }

      throw invalidValue(
        `invalid boolean value: ${value}; 示例：value=true&value_type=boolean`
      );

    case "null":
      return null;

    case "json":
      try { return JSON.parse(value); }
      catch (error) {
        throw invalidValue(`invalid JSON value: ${error.message}; 示例：value={"code":0}&value_type=json`);
      }

    default:
      throw invalidValue(
        `unsupported value_type: ${type}; 示例：value_type=string/number/boolean/null/json`
      );
  }
}


function invalidValue(message) {
  const error = new Error(message);
  error.name = "ConfigurationError";
  return error;
}

function describeValue(value) {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return `Array(${value.length})`;
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (_) {
      return "[object]";
    }
  }

  return `${typeof value}(${String(value)})`;
}

// ---------------------------------------------------------------------------
// headers
// ---------------------------------------------------------------------------

function copyHeaders(headers) {
  if (
    !headers ||
    typeof headers !== "object"
  ) {
    return {};
  }

  if (Array.isArray(headers)) {
    return headers.map(item => ({
      ...item
    }));
  }

  return {
    ...headers
  };
}

function setHeader(headers, name, value) {
  if (Array.isArray(headers)) {
    removeHeader(headers, name);

    headers.push({
      field: name,
      value: String(value)
    });

    return;
  }

  removeHeader(headers, name);
  headers[name] = String(value);
}

function removeHeader(headers, name) {
  const lower = name.toLowerCase();
  let removed = false;

  if (Array.isArray(headers)) {
    for (
      let i = headers.length - 1;
      i >= 0;
      i--
    ) {
      if (
        String(headers[i].field).toLowerCase() ===
        lower
      ) {
        headers.splice(i, 1);
        removed = true;
      }
    }

    return removed;
  }

  Object.keys(headers).forEach(key => {
    if (key.toLowerCase() === lower) {
      delete headers[key];
      removed = true;
    }
  });
  return removed;
}

// ---------------------------------------------------------------------------
// runtime helpers
// ---------------------------------------------------------------------------

function getBodyString() {
  if (
    !packet ||
    typeof packet.body !== "string"
  ) {
    return null;
  }

  return packet.body;
}

function parseArguments(raw) {
  const result = {};

  if (!raw) {
    return result;
  }

  // Extract the Module's pattern before parsing arguments that use "&".
  if (raw.startsWith("url_pattern=")) {
    const boundary = raw.indexOf(", target=");
    if (boundary !== -1) {
      result.url_pattern = raw.slice("url_pattern=".length, boundary).trim();
      raw = raw.slice(boundary + ", ".length);
    }
  }

  const pairs = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let escaped = false;
  let inPath = raw.startsWith("path=", start);
  let inValue = raw.startsWith("value=", start);
  const lastValueType = raw.lastIndexOf("&value_type=");
  const lastDelay = raw.lastIndexOf("&delay_ms=");
  const lastModuleVersion = raw.lastIndexOf("&module_version=");
  const findValueEnd = position => lastValueType > position
    ? lastValueType
    : lastDelay > position ? lastDelay
      : lastModuleVersion > position ? lastModuleVersion : raw.length;
  let valueEnd = inValue ? findValueEnd(start) : raw.length;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (inPath && quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (inPath && depth > 0 && (char === "'" || char === '"')) {
      quote = char;
    } else if (inPath && char === "[") {
      depth++;
    } else if (inPath && char === "]") {
      depth--;
    } else if (char === "&" && depth === 0 && (!inValue || i === valueEnd)) {
      pairs.push(raw.slice(start, i));
      start = i + 1;
      inPath = raw.startsWith("path=", start);
      inValue = raw.startsWith("value=", start);
      valueEnd = inValue ? findValueEnd(start) : raw.length;
    }
  }
  pairs.push(raw.slice(start));
  pairs.forEach(pair => {
    if (!pair) return;

    const separator = pair.indexOf("=");

    const key =
      separator >= 0
        ? pair.slice(0, separator)
        : pair;

    const value =
      separator >= 0
        ? pair.slice(separator + 1)
        : "";

    if (key) {
      result[key] = value;
    }
  });

  return result;
}

function toNumber(value, fallback) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function clamp(value, min, max) {
  return Math.min(
    max,
    Math.max(min, value)
  );
}

function unicodeLength(value) {
  return Array.from(
    String(value ?? "")
  ).length;
}

function invalid(message, example) {
  log(`invalid config: ${message}` + (example ? `; 示例：${example}` : ""), "配置错误");
  return finish({});
}

function log(message, outcome = "状态") {
  const ruleDirection = target === "reset"
    ? (panelScope ? panelScope.direction : (args.direction || "unknown"))
    : direction;
  console.log(
    `${PREFIX}[${ruleDirection}][${urlPattern || "unconfigured"}] [${outcome}] ${message}`
  );
}

function applyHit(result, message) {
  if (!allowHit()) return finish({});
  log(message, "已应用");
  return finish(result, true);
}

function readPanelScope() {
  const name = typeof $input === "undefined" ? "" : $input?.panelName;
  if (typeof name !== "string" || !name.startsWith("API-Debug-Reset|")) return null;
  const [, ruleDirection = "", limit = "", ...pattern] = name.split("|");
  return { direction: ruleDirection, hitLimitText: limit, urlPattern: pattern.join("|") };
}

function handleResetPanel() {
  if (typeof $input === "undefined" || $input?.purpose !== "panel") {
    return $done({});
  }

  const title = `重置次数 · hit_limit=${hitLimitText || "0"}`;
  const ruleDirection = panelScope ? panelScope.direction : args.direction;
  const scope = `${ruleDirection} · ${urlPattern}\n`;
  const validRule = urlPattern && Number.isSafeInteger(hitLimit)
    && (ruleDirection === "request" || ruleDirection === "response");
  if (!validRule) {
    return $done({ title, content: `${scope}配置无效：请检查 URL、方向和整数 hit_limit`, style: "error" });
  }
  if (typeof $trigger === "undefined" || $trigger !== "button") {
    const progress = hitLimit === 0 ? { ok: true, count: 0 } : readHitCounter(ruleDirection);
    if (!progress.ok) {
      return $done({ title, content: `${scope}${progress.message}`, style: "error" });
    }
    return $done({ title, content: `${scope}${hitProgress(progress.count)}\n点刷新清零此接口的生效次数`, style: "info" });
  }

  const cleared = resetHitCounter(hitCounterKey(ruleDirection));
  return $done(cleared
    ? { title, content: `${scope}${hitProgress(0)}\n已清零，下次命中从头计数`, style: "good" }
    : { title, content: `${scope}清零失败，请重试并检查脚本日志`, style: "error" }
  );
}

function hitProgress(count) {
  if (hitLimit === 0) return "不限次数（不记录次数）";
  if (hitLimit > 0) {
    return `前 ${hitLimit} 次生效；已生效 ${count} 次，剩余 ${hitLimit - count} 次`;
  }
  const threshold = -hitLimit;
  return `跳过前 ${threshold} 次；已跳过 ${count}/${threshold} 次` +
    (count === threshold ? "，已进入持续生效阶段" : "，之后持续生效");
}

function readHitCounter(ruleDirection) {
  if (!hitStore) return { ok: false, message: "hit counter storage unavailable; 计数存储不可用，无法读取进度" };
  let saved;
  try { saved = hitStore.read(hitCounterKey(ruleDirection)); }
  catch (_) { return { ok: false, message: "hit counter storage unavailable; 计数存储不可用，无法读取进度" }; }
  if (saved === null) return { ok: true, count: 0 };
  let state;
  try { state = JSON.parse(saved); }
  catch (_) { return { ok: false, message: "invalid hit counter; 计数状态损坏，点击面板刷新清零恢复" }; }
  if (!Number.isSafeInteger(state?.limit) || state.limit === 0 ||
      !Number.isSafeInteger(state.count) || state.count < 1 ||
      state.count > Math.abs(state.limit) || typeof state.urlPattern !== "string") {
    return { ok: false, message: "invalid hit counter; 计数状态损坏，点击面板刷新清零恢复" };
  }
  return { ok: true, count: state.limit === hitLimit && state.urlPattern === urlPattern ? state.count : 0 };
}

function hitCounterKey(ruleDirection) {
  // The HTTP script and reset panel share only this exact pattern/direction's slot.
  if (urlPattern) return `surge-api-debug-hits-v3-module-${ruleDirection}-${encodeURIComponent(urlPattern)}`;

  const name = typeof $script === "undefined" ? "" : $script?.name;
  return `surge-api-debug-hits-v2-${ruleDirection}-${encodeURIComponent(name || "API Debug")}`;
}

function resetHitCounter(key) {
  let cleared = false;
  try {
    if (hitStore) {
      if (hitStore.read(key) === null) return true;
      cleared = hitStore.write(null, key);
    }
  } catch {
    // A storage error must leave the HTTP script's unlimited mode working.
  }
  log(cleared ? "hit counter reset" : "could not reset hit counter");
  return cleared;
}

function allowHit() {
  // Missing or blank limits keep the original behavior without touching storage.
  if (!hitLimitText) return true;

  if (!hitStore) {
    if (hitLimit === 0) return true;
    log("hit counter storage unavailable; passthrough，计数存储不可用，保持原样", "已跳过");
    return false;
  }

  const key = hitCounterKey(direction);

  if (hitLimit === 0) {
    resetHitCounter(key);
    return true;
  }

  const progress = readHitCounter(direction);
  if (!progress.ok) {
    log(`${progress.message}; passthrough`, "已跳过");
    return false;
  }

  const count = progress.count;
  const threshold = Math.abs(hitLimit);
  if (count === threshold) {
    if (hitLimit > 0) log(`hit_limit=${hitLimit} reached; passthrough，已生效 ${count}/${threshold} 次，剩余 0 次`, "已跳过");
    return hitLimit < 0;
  }

  // Keep read and write synchronous. Surge does not expose an atomic increment.
  const next = count + 1;
  if (!hitStore.write(JSON.stringify({ limit: hitLimit, count: next, urlPattern }), key)) {
    log("could not save hit counter; passthrough，计数保存失败，保持原样", "已跳过");
    return false;
  }
  if (hitLimit < 0) log(`hit ${next}/${threshold} ignored; passthrough，已跳过 ${next}/${threshold} 次`, "已跳过");
  else log(`hit ${next}/${threshold} applied`);
  return hitLimit > 0;
}

function finish(result, shouldDelay = false) {
  if (shouldDelay && delayMs > 0) {
    log(`delay ${delayMs} ms`);

    setTimeout(
      () => $done(result),
      delayMs
    );
  } else {
    $done(result);
  }
}
