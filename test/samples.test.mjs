// Byte-for-byte round trip of real drawings saved by Jw_cad (version 600).
// Set JWW_SAMPLES_DIR to a folder of .jww files (CI uses the samples of github.com/neka-nat/ezjww).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readJww, writeJww } from '../dist/jww.js';

const dir = process.env.JWW_SAMPLES_DIR;
const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jww')) : [];

test('real Jw_cad files re-serialize byte-for-byte', { skip: files.length ? false : 'JWW_SAMPLES_DIR not set' }, () => {
  let checked = 0;
  for (const f of files) {
    const u8 = new Uint8Array(fs.readFileSync(path.join(dir, f)));
    const version = new DataView(u8.buffer, u8.byteOffset).getUint32(8, true);
    if (version !== 600) continue;
    let doc;
    try { doc = readJww(u8); } catch (e) { if (/unsupported object/.test(e.message)) continue; throw e; }
    const { header, entities } = doc;
    const out = writeJww(header, entities);
    assert.equal(Buffer.compare(Buffer.from(out), Buffer.from(u8.subarray(0, doc.end))), 0, f);
    assert.equal(doc.end, u8.length, f + ' has trailing data');
    checked++;
  }
  assert.ok(checked > 0, 'no version 600 samples found');
});
