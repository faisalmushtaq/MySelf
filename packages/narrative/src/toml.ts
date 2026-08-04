/**
 * TOML, in the subset a study configuration actually uses.
 *
 * The original app is configured by one TOML file per study — persona,
 * questions, language style, topic restriction, extraction keys, personas, a
 * worked example — and docs/08 §8.4 keeps that philosophy deliberately: a
 * researcher changes a study by editing a file, not by editing code. Keeping
 * the same format means the four existing study configs can be dropped in
 * rather than retyped.
 *
 * This reads and writes the subset those files use: comments, tables, nested
 * tables, arrays of tables, strings (basic, literal and triple-quoted),
 * integers, floats, booleans and arrays. It does not read dates, times, dotted
 * assignment keys, or inline tables.
 *
 * THE IMPORTANT PROPERTY IS NOT COVERAGE, IT IS THAT IT NEVER GUESSES. Anything
 * outside the subset raises an error naming the line. A parser that quietly
 * mis-reads a config is worse than one that refuses it: the study still runs,
 * and nobody finds out until the transcripts come back asking the wrong
 * questions.
 */

export class TomlError extends Error {
  constructor(message: string, public readonly line: number) {
    super(`line ${line}: ${message}`);
    this.name = "TomlError";
  }
}

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

interface Cursor {
  text: string;
  at: number;
  line: number;
}

const isBare = (c: string): boolean => /[A-Za-z0-9_-]/.test(c);

function skipSpace(cur: Cursor): void {
  while (cur.at < cur.text.length) {
    const c = cur.text[cur.at]!;
    if (c === " " || c === "\t") cur.at += 1;
    else if (c === "#") {
      while (cur.at < cur.text.length && cur.text[cur.at] !== "\n") cur.at += 1;
    } else break;
  }
}

/** Whitespace, comments and newlines — used inside multi-line arrays. */
function skipAll(cur: Cursor): void {
  for (;;) {
    skipSpace(cur);
    if (cur.text[cur.at] === "\n") {
      cur.at += 1;
      cur.line += 1;
    } else if (cur.text[cur.at] === "\r") {
      cur.at += 1;
    } else return;
  }
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  '"': '"',
  "\\": "\\",
  b: "\b",
  f: "\f",
};

function readBasicString(cur: Cursor, multiline: boolean): string {
  let out = "";
  for (;;) {
    if (cur.at >= cur.text.length) throw new TomlError("unterminated string", cur.line);
    const c = cur.text[cur.at]!;

    if (c === '"') {
      if (!multiline) {
        cur.at += 1;
        return out;
      }
      if (cur.text.startsWith('"""', cur.at)) {
        cur.at += 3;
        return out;
      }
      out += c;
      cur.at += 1;
      continue;
    }

    if (c === "\n") {
      if (!multiline) throw new TomlError("newline inside a single-quoted string", cur.line);
      cur.line += 1;
      out += c;
      cur.at += 1;
      continue;
    }

    if (c === "\\") {
      const next = cur.text[cur.at + 1];
      if (next === undefined) throw new TomlError("string ends in a backslash", cur.line);
      // A backslash before a newline in a multi-line string swallows the
      // whitespace that follows: how the original's long prompts are wrapped.
      if (multiline && (next === "\n" || next === "\r" || next === " " || next === "\t")) {
        let scan = cur.at + 1;
        while (scan < cur.text.length && /[ \t\r\n]/.test(cur.text[scan]!)) {
          if (cur.text[scan] === "\n") cur.line += 1;
          scan += 1;
        }
        cur.at = scan;
        continue;
      }
      if (next === "u" || next === "U") {
        const width = next === "u" ? 4 : 8;
        const hex = cur.text.slice(cur.at + 2, cur.at + 2 + width);
        if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) {
          throw new TomlError(`\\${next} needs ${width} hex digits`, cur.line);
        }
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        cur.at += 2 + width;
        continue;
      }
      const replacement = ESCAPES[next];
      if (replacement === undefined) throw new TomlError(`unknown escape '\\${next}'`, cur.line);
      out += replacement;
      cur.at += 2;
      continue;
    }

    out += c;
    cur.at += 1;
  }
}

function readLiteralString(cur: Cursor, multiline: boolean): string {
  const end = multiline ? "'''" : "'";
  const stop = cur.text.indexOf(end, cur.at);
  if (stop === -1) throw new TomlError("unterminated literal string", cur.line);
  const out = cur.text.slice(cur.at, stop);
  cur.line += [...out].filter((c) => c === "\n").length;
  cur.at = stop + end.length;
  return out;
}

function readValue(cur: Cursor): TomlValue {
  skipSpace(cur);
  const c = cur.text[cur.at];
  if (c === undefined) throw new TomlError("a key with no value", cur.line);

  if (cur.text.startsWith('"""', cur.at)) {
    cur.at += 3;
    // TOML drops a newline immediately after the opening delimiter.
    if (cur.text[cur.at] === "\n") {
      cur.at += 1;
      cur.line += 1;
    }
    return readBasicString(cur, true);
  }
  if (c === '"') {
    cur.at += 1;
    return readBasicString(cur, false);
  }
  if (cur.text.startsWith("'''", cur.at)) {
    cur.at += 3;
    if (cur.text[cur.at] === "\n") {
      cur.at += 1;
      cur.line += 1;
    }
    return readLiteralString(cur, true);
  }
  if (c === "'") {
    cur.at += 1;
    return readLiteralString(cur, false);
  }

  if (c === "[") {
    cur.at += 1;
    const items: TomlValue[] = [];
    for (;;) {
      skipAll(cur);
      if (cur.text[cur.at] === "]") {
        cur.at += 1;
        return items;
      }
      if (cur.at >= cur.text.length) throw new TomlError("unterminated array", cur.line);
      items.push(readValue(cur));
      skipAll(cur);
      if (cur.text[cur.at] === ",") {
        cur.at += 1;
        continue;
      }
      if (cur.text[cur.at] === "]") {
        cur.at += 1;
        return items;
      }
      throw new TomlError("expected ',' or ']' in an array", cur.line);
    }
  }

  if (c === "{") throw new TomlError("inline tables are not supported — use a [table] instead", cur.line);

  // Bare token: true, false, or a number.
  let end = cur.at;
  while (end < cur.text.length && !/[,\]\n\r#]/.test(cur.text[end]!)) end += 1;
  const token = cur.text.slice(cur.at, end).trim();
  cur.at = end;

  if (token === "true") return true;
  if (token === "false") return false;
  if (/^[+-]?(0|[1-9][0-9_]*)$/.test(token)) return Number.parseInt(token.replaceAll("_", ""), 10);
  if (/^[+-]?(0|[1-9][0-9_]*)\.[0-9_]+([eE][+-]?[0-9]+)?$/.test(token)) {
    return Number.parseFloat(token.replaceAll("_", ""));
  }
  if (token === "") throw new TomlError("a key with no value", cur.line);
  throw new TomlError(`'${token}' is not a value this reader understands`, cur.line);
}

function readKey(cur: Cursor): string {
  skipSpace(cur);
  const c = cur.text[cur.at];
  if (c === '"') {
    cur.at += 1;
    return readBasicString(cur, false);
  }
  if (c === "'") {
    cur.at += 1;
    return readLiteralString(cur, false);
  }
  let end = cur.at;
  while (end < cur.text.length && isBare(cur.text[end]!)) end += 1;
  if (end === cur.at) throw new TomlError("expected a key", cur.line);
  const key = cur.text.slice(cur.at, end);
  cur.at = end;
  return key;
}

/** A dotted table path: `summaries.questions` -> ["summaries", "questions"]. */
function readPath(cur: Cursor): string[] {
  const path = [readKey(cur)];
  for (;;) {
    skipSpace(cur);
    if (cur.text[cur.at] !== ".") return path;
    cur.at += 1;
    path.push(readKey(cur));
  }
}

type Table = Record<string, TomlValue>;

function descend(root: Table, path: string[], line: number): Table {
  let node: Table = root;
  for (const part of path) {
    let next = node[part];
    if (next === undefined) {
      next = {};
      node[part] = next;
    }
    if (Array.isArray(next)) {
      // Walking into the most recent element of an array of tables.
      const last = next[next.length - 1];
      if (last === undefined || typeof last !== "object" || Array.isArray(last)) {
        throw new TomlError(`'${path.join(".")}' is an array of values, not of tables`, line);
      }
      node = last as Table;
      continue;
    }
    if (typeof next !== "object") throw new TomlError(`'${part}' is already a value, not a table`, line);
    node = next as Table;
  }
  return node;
}

export function parseToml(text: string): Table {
  const root: Table = {};
  const cur: Cursor = { text: text.replaceAll("\r\n", "\n"), at: 0, line: 1 };
  let current = root;
  const defined = new Set<string>();

  for (;;) {
    skipAll(cur);
    if (cur.at >= cur.text.length) return root;

    if (cur.text[cur.at] === "[") {
      const arrayOfTables = cur.text.startsWith("[[", cur.at);
      cur.at += arrayOfTables ? 2 : 1;
      const path = readPath(cur);
      skipSpace(cur);
      const close = arrayOfTables ? "]]" : "]";
      if (!cur.text.startsWith(close, cur.at)) throw new TomlError(`expected '${close}'`, cur.line);
      cur.at += close.length;

      if (arrayOfTables) {
        const parent = descend(root, path.slice(0, -1), cur.line);
        const name = path[path.length - 1]!;
        const existing = parent[name];
        const list = Array.isArray(existing) ? existing : [];
        if (existing !== undefined && !Array.isArray(existing)) {
          throw new TomlError(`'${path.join(".")}' is already a table`, cur.line);
        }
        const entry: Table = {};
        list.push(entry);
        parent[name] = list;
        current = entry;
      } else {
        const name = path.join(".");
        if (defined.has(name)) throw new TomlError(`table '${name}' is defined twice`, cur.line);
        defined.add(name);
        current = descend(root, path, cur.line);
      }
      continue;
    }

    const key = readKey(cur);
    skipSpace(cur);
    if (cur.text[cur.at] !== "=") throw new TomlError(`expected '=' after '${key}'`, cur.line);
    cur.at += 1;
    const startLine = cur.line;
    const value = readValue(cur);
    if (key in current) throw new TomlError(`'${key}' is set twice`, startLine);
    current[key] = value;

    skipSpace(cur);
    const after = cur.text[cur.at];
    if (after !== undefined && after !== "\n") {
      throw new TomlError(`unexpected text after the value of '${key}'`, cur.line);
    }
  }
}

/* ------------------------------------------------------------------ writing */

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

const writeKey = (key: string): string => (BARE_KEY.test(key) ? key : JSON.stringify(key));

/**
 * Escape the quotes that would collide with the closing delimiter.
 *
 * The example conversations are full of quoted answers — `Answer: "I didn't
 * say anything"` — and one of them ending a block puts a quote right against
 * the `"""`, making four in a row. Escaping everything would be safe and
 * unreadable; escaping only a run that reaches three, and a trailing quote,
 * leaves ordinary speech marks alone.
 */
function escapeMultiline(value: string): string {
  const escaped = value.replaceAll("\\", "\\\\");
  let out = "";
  for (let i = 0; i < escaped.length; i += 1) {
    const c = escaped[i]!;
    if (c !== '"') {
      out += c;
      continue;
    }
    let run = 0;
    while (escaped[i + run] === '"') run += 1;
    const atEnd = i + run === escaped.length;
    out += run >= 3 || atEnd ? '\\"'.repeat(run) : '"'.repeat(run);
    i += run - 1;
  }
  return out;
}

function writeScalar(value: TomlValue): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TomlError(`${value} cannot be written as TOML`, 0);
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === "string") {
    // Long or multi-line text goes in a triple-quoted block, which is how the
    // prompts and the worked examples stay readable in a file a person edits.
    if (value.includes("\n")) return `"""\n${escapeMultiline(value)}"""`;
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const parts = value.map((v) => writeScalar(v));
    const inline = `[${parts.join(", ")}]`;
    if (inline.length <= 80 && !inline.includes("\n")) return inline;
    return `[\n${parts.map((p) => `  ${p},`).join("\n")}\n]`;
  }
  throw new TomlError("a table cannot be written as a value", 0);
}

const isTable = (v: TomlValue): v is Table => typeof v === "object" && v !== null && !Array.isArray(v);
const isTableArray = (v: TomlValue): boolean => Array.isArray(v) && v.length > 0 && v.every(isTable);

function writeTable(table: Table, path: string[], out: string[]): void {
  const scalars = Object.entries(table).filter(([, v]) => !isTable(v) && !isTableArray(v));
  const tables = Object.entries(table).filter(([, v]) => isTable(v) || isTableArray(v));

  if (path.length > 0 && (scalars.length > 0 || tables.length === 0)) {
    out.push(`[${path.map(writeKey).join(".")}]`);
  }
  for (const [key, value] of scalars) out.push(`${writeKey(key)} = ${writeScalar(value)}`);
  if (scalars.length > 0) out.push("");

  for (const [key, value] of tables) {
    if (isTableArray(value)) {
      for (const entry of value as Table[]) {
        out.push(`[[${[...path, key].map(writeKey).join(".")}]]`);
        for (const [k, v] of Object.entries(entry)) out.push(`${writeKey(k)} = ${writeScalar(v)}`);
        out.push("");
      }
      continue;
    }
    writeTable(value as Table, [...path, key], out);
  }
}

export function stringifyToml(table: Table): string {
  const out: string[] = [];
  writeTable(table, [], out);
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
