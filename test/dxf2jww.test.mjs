// DXF → JWW conversion on the fixtures made by tools/make_fixtures.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { convertDxfToJww } from '../dist/dxf2jww.js';
import { readJww } from '../dist/jww.js';

const sjis = new TextDecoder('shift_jis');
const fx = (n) => new Uint8Array(fs.readFileSync(new URL('./fixtures/' + n, import.meta.url)));
const convert = (n, opts = { paper: 3 }) => { const r = convertDxfToJww(fx(n), opts); return { ...r, doc: readJww(r.jww) }; };

for (const [name, enc] of [['r2018_utf8.dxf', 'utf-8'], ['r2000_sjis.dxf', 'shift_jis'], ['r2000_escaped.dxf', 'windows-1252']]) {
  test(`${name}: text, layers and geometry`, () => {
    const { info, doc } = convert(name);
    assert.equal(info.enc, enc);
    assert.equal(info.scale, 40); // 12.3 m × 7.8 m on A3 → 1/40
    const texts = doc.entities.filter((e) => e.t === 'moji').map((e) => sjis.decode(e.text));
    for (const t of ['配管 ルート A-1', '中央揃え', '冷凍機室', '2行目 φ50']) assert.ok(texts.includes(t), 'missing text ' + t);
    const names = []; for (let l = 0; l < 16; l++) names.push(sjis.decode(doc.header[`layName0.${l}`]));
    assert.deepEqual(names.slice(0, 2), ['壁', '設備-配管']);
    const hide = names.indexOf('HIDE');
    assert.equal(doc.header[`g0.l${hide}.state`], 0, 'layer that is off in DXF is hidden');
    // the 10 m wall line on layer 壁 becomes 250 mm on paper at 1/40, drawn in line colour 8 (red)
    const wall = doc.entities.find((e) => e.t === 'sen' && Math.abs(e.x2 - e.x1 - 250) < 1e-9 && e.y1 === e.y2);
    assert.ok(wall); assert.equal(wall.layer, 0); assert.equal(wall.color, 8);
    // dashed layer → line type 2; circle r=500 → 12.5 mm
    const circle = doc.entities.find((e) => e.t === 'enko' && e.full && Math.abs(e.r - 12.5) < 1e-9);
    assert.ok(circle); assert.equal(circle.style, 2);
    // ellipse: ratio 0.4, major 1118 mm
    const ell = doc.entities.find((e) => e.t === 'enko' && Math.abs(e.flat - 0.4) < 1e-9);
    assert.ok(ell); assert.ok(Math.abs(ell.r * 40 - Math.hypot(1000, 500)) < 1e-6);
    assert.ok(doc.entities.some((e) => e.t === 'solid' && e.color === 10), 'solid hatch becomes coloured solids');
    assert.deepEqual(info.skipped, {});
  });
}

test('fixed scale and paper are written to every layer group', () => {
  const { doc, info } = convert('r2018_utf8.dxf', { paper: 1, scale: 100 });
  assert.equal(info.scale, 100);
  assert.equal(doc.header.zumen, 1);
  for (let g = 0; g < 16; g++) assert.equal(doc.header[`g${g}.scale`], 100);
});

test('mirrored block text stays readable', () => {
  const { doc } = convert('r2018_utf8.dxf');
  const v = doc.entities.filter((e) => e.t === 'moji' && sjis.decode(e.text) === 'V');
  assert.equal(v.length, 3);
  for (const e of v) assert.ok(e.angle < 90 || e.angle > 270, 'upside-down text: ' + e.angle);
});

test('multileader: text and leader line', () => {
  const { doc } = convert('r2018_mleader.dxf');
  assert.ok(doc.entities.some((e) => e.t === 'moji' && sjis.decode(e.text) === '冷水配管 50A'));
  assert.ok(doc.entities.filter((e) => e.t === 'sen').length >= 2);
});

test('binary DXF is rejected with a clear message', () => {
  const bin = new TextEncoder().encode('AutoCAD Binary DXF\r\n\x1a\x00' + '\x00'.repeat(20));
  assert.throws(() => convertDxfToJww(bin), /バイナリ/);
});

test('very fine hatch becomes its outline; normal hatches stay as pattern lines', () => {
  const { info, doc } = convert('r2018_dense_hatch.dxf');
  assert.equal(info.hatch.dense, 1);
  assert.ok(info.hatch.lines > 20 && info.counts.点 > 1000, 'normal hatches still produce pattern lines and dots');
  assert.ok(!info.warnings.some((w) => /離れた/.test(w)), 'dense hatch dots do not look like stray objects');
  assert.ok(info.warnings.some((w) => /外形線/.test(w)));
  assert.ok(!info.warnings.some((w) => /省きました/.test(w)), 'nothing truncated');
  assert.ok(doc.entities.length < 60000);
});

test('hatch option: outline only / none', () => {
  const o = convert('r2018_dense_hatch.dxf', { paper: 3, hatch: 'outline' });
  assert.equal(o.info.hatch.outlined, 3);
  assert.equal(o.info.counts.線, 1 + 3 * 4); // wall line + 3 rectangles
  const n = convert('r2018_dense_hatch.dxf', { paper: 3, hatch: 'none' });
  assert.equal(n.info.hatch.skipped, 3);
  assert.equal(n.info.counts.線, 1);
});

test('millions of lines are converted without truncation', () => {
  // 2,000,000 LINE entities in one DXF
  const N = 2000000, parts = ['0\nSECTION\n2\nENTITIES\n'];
  for (let i = 0; i < N; i++) parts.push(`0\nLINE\n8\n0\n10\n${i % 1000}\n20\n${(i / 1000) | 0}\n11\n${(i % 1000) + 0.5}\n21\n${(i / 1000) | 0}\n`);
  parts.push('0\nENDSEC\n0\nEOF\n');
  const { info, jww } = convertDxfToJww(new TextEncoder().encode(parts.join('')), { paper: 3 });
  assert.equal(info.counts.線, N);
  assert.equal(info.warnings.length, 0);
  assert.equal(new DataView(jww.buffer).getUint16(jww.length - 2, true), 0); // block list count at the end
});
