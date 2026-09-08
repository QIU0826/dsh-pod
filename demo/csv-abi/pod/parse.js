// 组B：dsh-pod 多 harness（claude 实现 + codex 独立审 + dsh 独立审）产出，如实保留（未尽更正）。
// 判题：16/18 通过（.csv-abi-oracle 隐藏套件）。2 真缺陷，均被 codex 独立审 PASS 放过：
//   1) `a\n""`（显式空引号字段）被判为空行抛 "field count does not match"——应为 [{a:''}]。
//   2) skipEmptyLines:false 时内部空行被 tokenizer 静默丢弃——应为 [{a:'b'},{a:'b'}]（见 keep empty lines 用例）。
// 见 demo/csv-abi/README.md 对照结论。
/**
 * A self-contained zero-dependency CSV parser returning an array of objects.
 *
 * Each cell is { value, quoted } where `quoted` records whether the source
 * field was wrapped in double quotes (inside-quote whitespace is preserved).
 *
 * Exported as `parseCSV`. The enclosing package.json declares "type": "module",
 * so this file is ESM; require() of it returns the `{ parseCSV }` namespace.
 *
 * @param {string} text      Multi-line CSV content.
 * @param {object} [opts]    Options.
 * @param {boolean} [opts.skipEmptyLines=false] Skip fully blank data rows.
 * @param {boolean} [opts.trim=false]           Trim unquoted field whitespace.
 * @param {string}  [opts.delimiter=',']        Field delimiter (single char).
 * @returns {Array<object>} Records keyed by header cells.
 */
export function parseCSV(text, opts) {
  const o = Object.assign({ skipEmptyLines: false, trim: false, delimiter: ',' }, opts);
  const body = String(text == null ? '' : text)
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n');

  const records = tokenizeRecords(body, o.delimiter);

  // The header is the first non-empty record.
  while (records.length && records[0].cells.every((c) => c.value.trim() === '')) {
    records.shift();
  }
  if (records.length === 0) {
    return [];
  }

  const headerRec = records.shift();
  const header = headerRec.cells.map((c) => c.value.trim());
  const seen = new Set();
  for (let i = 0; i < header.length; i++) {
    if (header[i] === '') {
      throw new Error('line 1, field ' + (i + 1) + ': empty header field');
    }
    if (seen.has(header[i])) {
      throw new Error('line 1, field ' + (i + 1) + ': duplicate header "' + header[i] + '"');
    }
    seen.add(header[i]);
  }

  const out = [];
  for (const rec of records) {
    const blank = rec.cells.every((c) => c.value.trim() === '');
    if (blank) {
      if (o.skipEmptyLines) {
        continue;
      }
      throw new Error('line ' + rec.line + ': field count ' + rec.cells.length +
        ' does not match header count ' + header.length);
    }
    if (rec.cells.length !== header.length) {
      throw new Error('line ' + rec.line + ': field count ' + rec.cells.length +
        ' does not match header count ' + header.length);
    }
    const obj = {};
    const strip = o.trim;
    for (let i = 0; i < header.length; i++) {
      obj[header[i]] = rec.cells[i].quoted ? rec.cells[i].value
        : (strip ? rec.cells[i].value.trim() : rec.cells[i].value);
    }
    out.push(obj);
  }
  return out;
}

/**
 * Parse the whole body into logical records of cell objects, resolving quotes.
 * A quoted field may span embedded newlines and CRLF.
 *
 * @param {string} body
 * @param {string} delim
 * @returns {Array<{line: number, cells: Array<{value: string, quoted: boolean}>}>}
 */
function tokenizeRecords(body, delim) {
  const records = [];
  let cells = [];
  let value = '';
  let quoted = false;
  let inQuotes = false;
  let line = 1;
  let startLine = 1;
  let cellCount = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        value += ch;
      }
      continue;
    }

    if (ch === '"' && value === '' && !quoted) {
      quoted = true;
      inQuotes = true;
      continue;
    }
    if (ch === delim) {
      cells.push({ value: value, quoted: quoted });
      value = '';
      quoted = false;
      cellCount++;
      continue;
    }
    if (ch === '\n') {
      if (cellCount || value !== '' || quoted) {
        cells.push({ value: value, quoted: quoted });
        records.push({ line: startLine, cells: cells });
      }
      cells = [];
      value = '';
      quoted = false;
      cellCount = 0;
      line++;
      startLine = line;
      continue;
    }
    value += ch;
  }

  if (inQuotes) {
    throw new Error('line ' + line + ', field ' + (cells.length + 1) +
      ': unterminated quoted field');
  }
  if (cellCount || value !== '' || quoted) {
    cells.push({ value: value, quoted: quoted });
    records.push({ line: startLine, cells: cells });
  }
  return records;
}