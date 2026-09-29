// DWG → DXF with LibreDWG (WebAssembly), then → JWW. Uses LibreDWG's sample DWGs when present
// (CI downloads them into test/fixtures/external/).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import createModule from '../dist/libredwg-web.js';
import { convertDxfToJww } from '../dist/dxf2jww.js';
import { readJww } from '../dist/jww.js';

const dir = new URL('./fixtures/external/', import.meta.url);
const dwgs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.dwg$/i.test(f)) : [];

test('DWG files convert to DXF and JWW', { skip: dwgs.length ? false : 'no DWG in test/fixtures/external' }, async () => {
  const m = await createModule({ print() {}, printErr() {} });
  for (const f of dwgs) {
    m.FS.writeFile('in.dwg', new Uint8Array(fs.readFileSync(new URL(f, dir))));
    const code = m.dwg_write_dxf('in.dwg', 'out.dxf');
    assert.ok(code < 128, f + ' error code ' + code);
    const dxf = m.FS.readFile('out.dxf'); m.FS.unlink('out.dxf');
    const { jww, info } = convertDxfToJww(dxf, { paper: 3 });
    const doc = readJww(jww);
    assert.ok(doc.entities.length > 100, f);
    assert.ok(info.counts.線 > 0 && info.counts.円弧 > 0, f);
  }
});
