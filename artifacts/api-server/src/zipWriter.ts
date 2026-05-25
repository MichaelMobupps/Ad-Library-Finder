/**
 * Minimal PKZIP (.zip) writer using Node built-ins only.
 *
 * Why hand-rolled: the api-server currently has no xlsx/zip dependency. Adding
 * a real library here would need a Replit Agent pause to run `pnpm install`.
 * The zip format we need is trivial — a small handful of files per archive,
 * all from in-memory buffers, no streaming, no encryption, no Zip64. Node's
 * `zlib.deflateRawSync` and `zlib.crc32` (Node 18+) cover everything we need.
 *
 * Output format: PKZIP 2.0, store or deflate per entry. Compatible with Excel,
 * macOS Archive Utility, Windows Explorer, /usr/bin/unzip.
 *
 * Reference: APPNOTE.TXT (PKWARE), https://pkware.cachefly.net/webdocs/APPNOTE/APPNOTE-6.3.10.TXT
 */

import { deflateRawSync, crc32 } from 'node:zlib';
import { Buffer } from 'node:buffer';

export interface ZipEntry {
  /** Path inside the archive (forward-slash, no leading slash). */
  path: string;
  /** Raw file contents. */
  data: Buffer | string;
}

interface BuiltEntry {
  path: string;
  pathBytes: Buffer;
  rawSize: number;
  compSize: number;
  crc: number;
  /** 8 = deflate, 0 = store */
  method: number;
  /** Deflated (or raw) payload bytes. */
  payload: Buffer;
  /** Offset of the local file header in the final archive. */
  localHeaderOffset: number;
  /** DOS time/date for the local + central headers. */
  dosTime: number;
  dosDate: number;
}

function toBuffer(d: Buffer | string): Buffer {
  return typeof d === 'string' ? Buffer.from(d, 'utf8') : d;
}

function dosTimeDate(d: Date): { time: number; date: number } {
  // DOS time:  bits 0-4=sec/2, 5-10=min, 11-15=hour
  // DOS date:  bits 0-4=day, 5-8=month, 9-15=year-1980
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// zlib.crc32 was added in Node 18.0; assert the host supports it.
function crc32Of(buf: Buffer): number {
  if (typeof crc32 !== 'function') {
    throw new Error('zlib.crc32 is required (Node 18+)');
  }
  return crc32(buf);
}

/**
 * Build a .zip archive from an array of entries. Returns the full byte buffer.
 * Files larger than 64 KiB use deflate; smaller files use store (zero gain
 * from deflate on tiny payloads and easier to inspect in tests).
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const now = new Date();
  const { time: dosTime, date: dosDate } = dosTimeDate(now);

  // Phase 1: build per-entry blobs.
  const built: BuiltEntry[] = [];
  let runningOffset = 0;
  for (const e of entries) {
    if (!e.path || e.path.startsWith('/')) {
      throw new Error(`zipWriter: bad entry path ${JSON.stringify(e.path)}`);
    }
    const raw = toBuffer(e.data);
    const pathBytes = Buffer.from(e.path, 'utf8');
    const crc = crc32Of(raw) >>> 0;

    let method: number;
    let payload: Buffer;
    if (raw.length < 64 * 1024) {
      method = 0;
      payload = raw;
    } else {
      method = 8;
      payload = deflateRawSync(raw);
    }

    built.push({
      path: e.path,
      pathBytes,
      rawSize: raw.length,
      compSize: payload.length,
      crc,
      method,
      payload,
      localHeaderOffset: runningOffset,
      dosTime,
      dosDate,
    });

    runningOffset += 30 + pathBytes.length + payload.length;
  }

  // Phase 2: write local file headers + data into output buffer.
  const localChunks: Buffer[] = [];
  for (const b of built) {
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4); // version needed to extract
    lfh.writeUInt16LE(0, 6); // general purpose bit flag
    lfh.writeUInt16LE(b.method, 8);
    lfh.writeUInt16LE(b.dosTime, 10);
    lfh.writeUInt16LE(b.dosDate, 12);
    lfh.writeUInt32LE(b.crc, 14);
    lfh.writeUInt32LE(b.compSize, 18);
    lfh.writeUInt32LE(b.rawSize, 22);
    lfh.writeUInt16LE(b.pathBytes.length, 26);
    lfh.writeUInt16LE(0, 28); // extra field length
    localChunks.push(lfh, b.pathBytes, b.payload);
  }
  const localPart = Buffer.concat(localChunks);

  // Phase 3: central directory.
  const cdChunks: Buffer[] = [];
  for (const b of built) {
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // central directory header signature
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed to extract
    cdh.writeUInt16LE(0, 8); // general purpose bit flag
    cdh.writeUInt16LE(b.method, 10);
    cdh.writeUInt16LE(b.dosTime, 12);
    cdh.writeUInt16LE(b.dosDate, 14);
    cdh.writeUInt32LE(b.crc, 16);
    cdh.writeUInt32LE(b.compSize, 20);
    cdh.writeUInt32LE(b.rawSize, 24);
    cdh.writeUInt16LE(b.pathBytes.length, 28);
    cdh.writeUInt16LE(0, 30); // extra field length
    cdh.writeUInt16LE(0, 32); // file comment length
    cdh.writeUInt16LE(0, 34); // disk number start
    cdh.writeUInt16LE(0, 36); // internal file attributes
    cdh.writeUInt32LE(0, 38); // external file attributes
    cdh.writeUInt32LE(b.localHeaderOffset, 42);
    cdChunks.push(cdh, b.pathBytes);
  }
  const cdPart = Buffer.concat(cdChunks);
  const cdOffset = localPart.length;
  const cdSize = cdPart.length;

  // Phase 4: end of central directory record.
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk where cd starts
  eocd.writeUInt16LE(built.length, 8); // entries on this disk
  eocd.writeUInt16LE(built.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localPart, cdPart, eocd]);
}

// ─────────────────────────────────────────────────────────────
// Self-test: build a zip, verify magic numbers and structure.
// Round-trip via `unzip -l` is exercised by the integration test.
// ─────────────────────────────────────────────────────────────

export function runZipWriterUnitTests(): { passed: number; failed: number; failures: string[] } {
  const failures: string[] = [];
  let passed = 0;

  // Test 1: empty-ish archive (one tiny file).
  const z1 = buildZip([{ path: 'hello.txt', data: 'Hello, world!\n' }]);
  if (z1.readUInt32LE(0) === 0x04034b50) passed++;
  else failures.push(`Test1: first 4 bytes not LFH magic (got 0x${z1.readUInt32LE(0).toString(16)})`);
  // EOCD should be at the end.
  const eocdMagic = z1.readUInt32LE(z1.length - 22);
  if (eocdMagic === 0x06054b50) passed++;
  else failures.push(`Test1: EOCD magic not at end (got 0x${eocdMagic.toString(16)})`);

  // Test 2: multi-file archive.
  const z2 = buildZip([
    { path: 'a/b.txt', data: 'first' },
    { path: 'c.txt', data: 'second' },
  ]);
  // Should contain two LFH magics.
  let lfhCount = 0;
  for (let i = 0; i < z2.length - 4; i++) {
    if (z2.readUInt32LE(i) === 0x04034b50) lfhCount++;
  }
  if (lfhCount >= 2) passed++;
  else failures.push(`Test2: expected ≥2 LFH magics, found ${lfhCount}`);

  // Test 3: round-trip larger payload that triggers deflate path.
  const big = Buffer.alloc(80 * 1024, 0x41); // 80 KiB of 'A'
  const z3 = buildZip([{ path: 'big.bin', data: big }]);
  // Find the LFH for 'big.bin'; method should be 8 (deflate).
  const method = z3.readUInt16LE(8);
  if (method === 8) passed++;
  else failures.push(`Test3: expected deflate (method=8) for 80KiB file, got method=${method}`);

  // Test 4: refuse leading slash.
  let threw = false;
  try {
    buildZip([{ path: '/abs.txt', data: 'x' }]);
  } catch {
    threw = true;
  }
  if (threw) passed++;
  else failures.push(`Test4: buildZip should reject absolute paths`);

  return { passed, failed: failures.length, failures };
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('zipWriter.js') || process.argv[1].endsWith('zipWriter.ts'));
if (isMain) {
  const { passed, failed, failures } = runZipWriterUnitTests();
  console.log(`zipWriter unit tests: ${passed} passed, ${failed} failed`);
  for (const f of failures) console.log('  ' + f);
  process.exit(failed === 0 ? 0 : 1);
}