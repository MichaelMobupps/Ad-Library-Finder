/**
 * Minimal .xlsx (Office Open XML SpreadsheetML) writer. Built directly on
 * zipWriter — no external dependencies.
 *
 * Why hand-rolled: same reason as zipWriter. The xlsx format is verbose but
 * the subset we need (a single sheet of strings, no formulas, no styles, no
 * merged cells) is a few hundred bytes of boilerplate XML plus the cell data.
 *
 * Layout of a minimal valid xlsx:
 *   [Content_Types].xml
 *   _rels/.rels
 *   xl/workbook.xml
 *   xl/_rels/workbook.xml.rels
 *   xl/worksheets/sheet1.xml
 *   xl/sharedStrings.xml (optional but we use it: shrinks repeated values)
 *
 * Cells use the inlineStr type so we can skip sharedStrings entirely if it
 * adds complexity — but we keep sharedStrings for compactness when the same
 * value (e.g. country code) repeats across rows.
 *
 * Open question for future: should we ever need formulas, styles, or types
 * beyond string + number, swap to ExcelJS. For HQ-split deliverables a
 * string-only sheet is the right shape.
 */

import { buildZip, ZipEntry } from './zipWriter.js';
import { Buffer } from 'node:buffer';

export interface SheetData {
  /** Sheet tab name (Excel limit: 31 chars). */
  name: string;
  /** Row 1 = header. Subsequent rows = data. */
  rows: (string | number | null | undefined)[][];
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strip control characters that XML 1.0 forbids (other than \t, \n, \r).
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function sanitizeSheetName(s: string): string {
  // Excel: 31 chars max, none of: / \ ? * [ ] :
  return s.replace(/[\/\\?*\[\]:]/g, '_').slice(0, 31) || 'Sheet1';
}

/** Convert 0-indexed column → Excel letter (A, B, ..., Z, AA, AB, ...). */
export function columnLetter(idx: number): string {
  let n = idx;
  let out = '';
  while (true) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    if (n < 26) break;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

interface SharedStringTable {
  strings: string[];
  indexByValue: Map<string, number>;
}

function newStringTable(): SharedStringTable {
  return { strings: [], indexByValue: new Map() };
}

function getOrAddString(table: SharedStringTable, value: string): number {
  const existing = table.indexByValue.get(value);
  if (existing !== undefined) return existing;
  const idx = table.strings.length;
  table.strings.push(value);
  table.indexByValue.set(value, idx);
  return idx;
}

/**
 * Build the xlsx archive for a single sheet. Returns a Buffer holding the
 * .xlsx file bytes (which is itself a zip).
 */
export function buildXlsx(sheet: SheetData): Buffer {
  const sheetName = sanitizeSheetName(sheet.name);
  const table = newStringTable();

  // sheet1.xml body
  const rowsXml: string[] = [];
  for (let r = 0; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    const rowNum = r + 1;
    const cellsXml: string[] = [];
    for (let c = 0; c < row.length; c++) {
      const val = row[c];
      if (val === null || val === undefined || val === '') continue;
      const ref = `${columnLetter(c)}${rowNum}`;
      if (typeof val === 'number' && Number.isFinite(val)) {
        cellsXml.push(`<c r="${ref}"><v>${val}</v></c>`);
      } else {
        const s = String(val);
        const idx = getOrAddString(table, s);
        cellsXml.push(`<c r="${ref}" t="s"><v>${idx}</v></c>`);
      }
    }
    if (cellsXml.length > 0) {
      rowsXml.push(`<row r="${rowNum}">${cellsXml.join('')}</row>`);
    } else {
      rowsXml.push(`<row r="${rowNum}"/>`);
    }
  }

  const sheetXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData>' + rowsXml.join('') + '</sheetData>' +
    '</worksheet>';

  // sharedStrings.xml
  const sharedStringsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${table.strings.length}" uniqueCount="${table.strings.length}">` +
    table.strings.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join('') +
    '</sst>';

  // workbook.xml
  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    `<sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/>` +
    '</sheets>' +
    '</workbook>';

  // xl/_rels/workbook.xml.rels
  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
    '</Relationships>';

  // _rels/.rels
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  // [Content_Types].xml
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '</Types>';

  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', data: contentTypes },
    { path: '_rels/.rels', data: rootRels },
    { path: 'xl/workbook.xml', data: workbookXml },
    { path: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { path: 'xl/worksheets/sheet1.xml', data: sheetXml },
    { path: 'xl/sharedStrings.xml', data: sharedStringsXml },
  ];

  return buildZip(entries);
}

// ─────────────────────────────────────────────────────────────
// Self-tests
// ─────────────────────────────────────────────────────────────

export function runXlsxWriterUnitTests(): { passed: number; failed: number; failures: string[] } {
  const failures: string[] = [];
  let passed = 0;

  // Test 1: columnLetter
  const colTests: Array<[number, string]> = [
    [0, 'A'], [1, 'B'], [25, 'Z'], [26, 'AA'], [27, 'AB'], [51, 'AZ'], [52, 'BA'], [701, 'ZZ'], [702, 'AAA'],
  ];
  for (const [n, expected] of colTests) {
    const got = columnLetter(n);
    if (got === expected) passed++;
    else failures.push(`columnLetter(${n}) = ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`);
  }

  // Test 2: build a small workbook, verify it's a valid zip with required parts.
  const buf = buildXlsx({
    name: 'TestSheet',
    rows: [
      ['header1', 'header2', 'header3'],
      ['alpha', 42, 'gamma'],
      ['delta', null, 'zeta'],
    ],
  });
  // First 4 bytes: PK\x03\x04
  if (buf.readUInt32LE(0) === 0x04034b50) passed++;
  else failures.push(`xlsx Test2: bad zip magic ${buf.readUInt32LE(0).toString(16)}`);

  // Contains the [Content_Types].xml path string somewhere
  const asText = buf.toString('binary');
  if (asText.includes('[Content_Types].xml')) passed++;
  else failures.push(`xlsx Test2: archive missing [Content_Types].xml entry`);
  if (asText.includes('xl/worksheets/sheet1.xml')) passed++;
  else failures.push(`xlsx Test2: archive missing sheet1.xml entry`);

  // Test 3: sheet-name sanitization
  const sanitized = buildXlsx({ name: 'a/b\\c:d?e*f[g]h_with_a_very_long_name_that_should_be_truncated_to_31', rows: [['x']] });
  if (sanitized.length > 100) passed++;
  else failures.push(`xlsx Test3: sanitized xlsx should still build (got ${sanitized.length} bytes)`);

  // Test 4: empty rows
  const empty = buildXlsx({ name: 'Empty', rows: [] });
  if (empty.readUInt32LE(0) === 0x04034b50) passed++;
  else failures.push(`xlsx Test4: empty workbook should still be a valid zip`);

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('xlsxWriter.js') || process.argv[1].endsWith('xlsxWriter.ts'));
if (isMain) {
  const { passed, failed, failures } = runXlsxWriterUnitTests();
  console.log(`xlsxWriter unit tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}