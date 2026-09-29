// JWW writer: Shift_JIS encoding, MFC serialization, write → read round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSjis, writeJww, readJww, ByteWriter } from '../dist/jww.js';
import DEFAULT_HEADER from '../dist/jww-header.js';

const sjis = new TextDecoder('shift_jis');

test('Shift_JIS encoding round-trips Japanese, half-width kana and ASCII', () => {
  for (const s of ['冷凍機室 φ50', 'ｱｲｳｴｵ ﾊﾟｲﾌﾟ', 'ABC-123_xyz', '①②③ ㎜ ㎡', '髙﨑']) {
    assert.equal(sjis.decode(encodeSjis(s)), s);
  }
});

test('characters without a Shift_JIS form become "?" or a close equivalent', () => {
  assert.equal(sjis.decode(encodeSjis('😀')), '?');
  assert.equal(sjis.decode(encodeSjis('−')), '－'); // minus sign
});

test('MFC CString length prefix: BYTE, then 0xFF + WORD', () => {
  const w = new ByteWriter();
  w.cstr('a'.repeat(10)); w.cstr('b'.repeat(300));
  const u = w.result();
  assert.equal(u[0], 10);
  assert.equal(u[11], 0xFF); assert.equal(u[12] | (u[13] << 8), 300);
});

test('write → read keeps every entity field', () => {
  const ents = [
    { t: 'sen', layer: 1, glayer: 2, style: 2, color: 3, x1: 1.5, y1: -2, x2: 3, y2: 4 },
    { t: 'enko', color: 8, cx: 0, cy: 0, r: 10, start: 0.5, sweep: 1.2, tilt: 0.3, flat: 0.5, full: 0 },
    { t: 'ten', color: 1, x: 5, y: 6 },
    { t: 'moji', color: 2, x1: 0, y1: 0, x2: 20, y2: 0, shu: 0, sx: 4, sy: 4, kankaku: 0, angle: 90, font: 'ＭＳ ゴシック', text: '配管 50A' },
    { t: 'solid', color: 2, rgb: 0x00C0C0C0, p: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  ];
  const { header, entities, blockCount } = readJww(writeJww({ ...DEFAULT_HEADER }, ents));
  assert.equal(header.version, 600);
  assert.equal(blockCount, 0);
  assert.equal(entities.length, ents.length);
  assert.deepEqual([entities[0].x1, entities[0].y2, entities[0].layer, entities[0].glayer, entities[0].style], [1.5, 4, 1, 2, 2]);
  assert.deepEqual([entities[1].r, entities[1].flat, entities[1].tilt], [10, 0.5, 0.3]);
  assert.equal(sjis.decode(entities[3].text), '配管 50A');
  assert.equal(entities[3].angle, 90);
  assert.equal(entities[4].color, 10); assert.equal(entities[4].rgb, 0x00C0C0C0);
  assert.deepEqual(entities[4].p, ents[4].p);
});

test('class tags: first object of a class declares it, later ones reference it', () => {
  const ents = Array.from({ length: 3 }, (_, i) => ({ t: 'sen', x1: i, y1: 0, x2: i, y2: 1 }));
  const u = writeJww({ ...DEFAULT_HEADER }, ents);
  const s = Buffer.from(u).toString('latin1');
  assert.equal(s.split('CDataSen').length - 1, 1); // declared once
  const i = s.indexOf('\xff\xff\x58\x02\x08\x00CDataSen'); // 0xFFFF, schema 600, name length 8
  assert.ok(i > 0);
});
