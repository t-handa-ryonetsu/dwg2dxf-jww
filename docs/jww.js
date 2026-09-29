// JWW (Jw_cad) binary reader/writer — data version 600 (Jw_cad Ver.6.00 and later can read it).
// Layout follows Jw_cad's published "Jw_cadのデータ形式" and MFC CArchive serialization.

// ---------- Shift_JIS (CP932) encoding, table built from the platform decoder ----------
let SJIS_MAP = null;
function buildSjis() {
  const dec = new TextDecoder('shift_jis');
  const map = new Map();
  const b2 = new Uint8Array(2);
  for (let a = 0xA1; a <= 0xDF; a++) { const c = dec.decode(new Uint8Array([a])); if (c.length === 1 && c !== '\uFFFD') map.set(c, [a]); }
  const leads = [];
  for (let a = 0x81; a <= 0x9F; a++) leads.push(a);
  for (let a = 0xE0; a <= 0xFC; a++) leads.push(a);
  for (const a of leads) {
    for (let b = 0x40; b <= 0xFC; b++) {
      if (b === 0x7F) continue;
      b2[0] = a; b2[1] = b;
      const c = dec.decode(b2);
      if (c.length === 1 && c !== '\uFFFD' && !map.has(c)) map.set(c, [a, b]);
    }
  }
  return map;
}
export function encodeSjis(str) {
  if (!SJIS_MAP) SJIS_MAP = buildSjis();
  const out = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { out.push(cp); continue; }
    const m = SJIS_MAP.get(ch) || SJIS_MAP.get(fallbackChar(ch));
    if (m) out.push(...m); else out.push(0x3F);
  }
  return new Uint8Array(out);
}
function fallbackChar(ch) {
  const f = { ' ': ' ', '−': '－', '〜': '～', '±': '±', '°': '°', '⌀': 'φ', 'Ø': 'φ', 'ø': 'φ', '—': '―', '¢': '￠', '£': '￡', '¬': '￢' };
  return f[ch] || ch;
}

// ---------- byte writer ----------
export class ByteWriter {
  constructor(size = 1 << 16) { this.buf = new ArrayBuffer(size); this.u8 = new Uint8Array(this.buf); this.dv = new DataView(this.buf); this.pos = 0; }
  ensure(n) {
    if (this.pos + n <= this.buf.byteLength) return;
    let s = this.buf.byteLength * 2; while (s < this.pos + n) s *= 2;
    const nb = new ArrayBuffer(s); new Uint8Array(nb).set(this.u8.subarray(0, this.pos));
    this.buf = nb; this.u8 = new Uint8Array(nb); this.dv = new DataView(nb);
  }
  u8w(v) { this.ensure(1); this.dv.setUint8(this.pos, v); this.pos += 1; }
  u16(v) { this.ensure(2); this.dv.setUint16(this.pos, v, true); this.pos += 2; }
  u32(v) { this.ensure(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  f64(v) { this.ensure(8); this.dv.setFloat64(this.pos, v, true); this.pos += 8; }
  bytes(a) { this.ensure(a.length); this.u8.set(a, this.pos); this.pos += a.length; }
  ascii(s) { for (let i = 0; i < s.length; i++) this.u8w(s.charCodeAt(i)); }
  // MFC CString (MBCS): length BYTE, or 0xFF + WORD, or 0xFF 0xFFFF + DWORD
  cstr(s) {
    const b = typeof s === 'string' ? encodeSjis(s) : s;
    const n = b.length;
    if (n < 0xFF) this.u8w(n);
    else if (n < 0xFFFE) { this.u8w(0xFF); this.u16(n); }
    else { this.u8w(0xFF); this.u16(0xFFFF); this.u32(n); }
    this.bytes(b);
  }
  count(n) { if (n < 0xFFFF) this.u16(n); else { this.u16(0xFFFF); this.u32(n); } }
  result() { return this.u8.slice(0, this.pos); }
}

// ---------- byte reader (used for tests and for reading the header template) ----------
export class ByteReader {
  constructor(u8) { this.u8 = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.pos = 0; }
  u8r() { return this.dv.getUint8(this.pos++); }
  u16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
  raw(n) { const v = this.u8.slice(this.pos, this.pos + n); this.pos += n; return v; }
  cstrRaw() {
    let n = this.u8r();
    if (n === 0xFF) { n = this.u16(); if (n === 0xFFFF) n = this.u32(); }
    return this.raw(n);
  }
  count() { const w = this.u16(); return w === 0xFFFF ? this.u32() : w; }
}

// ---------- header ----------
// Header is described as an ordered list of fields; strings are kept as raw bytes.
// Each entry: [name, type, repeat?]. Types: D=DWORD, F=double, S=CString.
function headerSpec() {
  const s = [];
  s.push(['memo', 'S'], ['zumen', 'D'], ['writeGLay', 'D']);
  for (let g = 0; g < 16; g++) {
    s.push([`g${g}.state`, 'D'], [`g${g}.writeLay`, 'D'], [`g${g}.scale`, 'F'], [`g${g}.protect`, 'D']);
    for (let l = 0; l < 16; l++) s.push([`g${g}.l${l}.state`, 'D'], [`g${g}.l${l}.protect`, 'D']);
  }
  for (let i = 0; i < 14; i++) s.push([`dummy${i}`, 'D']);
  for (let i = 1; i <= 5; i++) s.push([`sunpou${i}`, 'D']);
  s.push(['dummy14', 'D'], ['maxDrawWid', 'D'], ['prtGentenX', 'F'], ['prtGentenY', 'F'], ['prtBairitsu', 'F'], ['prtSet', 'D'],
    ['memoriMode', 'D'], ['memoriMin', 'F'], ['memoriX', 'F'], ['memoriY', 'F'], ['memoriKijunX', 'F'], ['memoriKijunY', 'F']);
  for (let g = 0; g < 16; g++) for (let l = 0; l < 16; l++) s.push([`layName${g}.${l}`, 'S']);
  for (let g = 0; g < 16; g++) s.push([`gLayName${g}`, 'S']);
  s.push(['kageLevel', 'F'], ['kageIdo', 'F'], ['kage9_15', 'D'], ['kabeKageLevel', 'F'], ['tenkuuLevel', 'F'], ['tenkuuR2', 'F'],
    ['mmTani3D', 'D'], ['bairitsu', 'F'], ['gentenX', 'F'], ['gentenY', 'F'], ['hanniBairitsu', 'F'], ['hanniX', 'F'], ['hanniY', 'F']);
  for (let n = 1; n <= 8; n++) s.push([`zoom${n}.b`, 'F'], [`zoom${n}.x`, 'F'], [`zoom${n}.y`, 'F'], [`zoom${n}.g`, 'D']);
  s.push(['dDm11', 'F'], ['dDm12', 'F'], ['dDm13', 'F'], ['lnDm1', 'D'], ['dDm21', 'F'], ['dDm22', 'F'], ['mojiBGd', 'F'], ['mojiBG', 'D']);
  for (let n = 0; n <= 9; n++) s.push([`fukusen${n}`, 'F']);
  s.push(['ryogawaTomeDe', 'F']);
  for (let n = 0; n <= 9; n++) s.push([`penColor${n}`, 'D'], [`penWidth${n}`, 'D']);
  for (let n = 0; n <= 9; n++) s.push([`prtColor${n}`, 'D'], [`prtWidth${n}`, 'D'], [`prtTenR${n}`, 'F']);
  for (let n = 2; n <= 9; n++) s.push([`lt${n}.p`, 'D'], [`lt${n}.dot`, 'D'], [`lt${n}.pich`, 'D'], [`lt${n}.prt`, 'D']);
  for (let n = 11; n <= 15; n++) s.push([`rnd${n}.p`, 'D'], [`rnd${n}.w`, 'D'], [`rnd${n}.pich`, 'D'], [`rnd${n}.pw`, 'D'], [`rnd${n}.pp`, 'D']);
  for (let n = 16; n <= 19; n++) s.push([`blt${n}.p`, 'D'], [`blt${n}.dot`, 'D'], [`blt${n}.pich`, 'D'], [`blt${n}.prt`, 'D']);
  s.push(['drawGamenTen', 'D'], ['drawPrtTen', 'D'], ['bitMapFirst', 'D'], ['gyakuDraw', 'D'], ['gyakuSearch', 'D'], ['colorPrint', 'D'],
    ['layJunPrint', 'D'], ['colJunPrint', 'D'], ['prtRenzoku', 'D'], ['prtKyoutsuuGray', 'D'], ['prtDispOnlyNonDraw', 'D'], ['drawTime', 'D'],
    ['eyeInit', 'D'], ['eyeH1', 'D'], ['eyeH2', 'D'], ['eyeH3', 'D'], ['eyeZ1', 'F'], ['eyeY1', 'F'], ['eyeZ2', 'F'], ['eyeY2', 'F'], ['eyeV3', 'F'],
    ['senNagasa', 'F'], ['boxX', 'F'], ['boxY', 'F'], ['enHankei', 'F'], ['solidNinni', 'D'], ['solidColor', 'D']);
  for (let n = 0; n <= 256; n++) s.push([`sxc${n}.c`, 'D'], [`sxc${n}.w`, 'D']);
  for (let n = 0; n <= 256; n++) s.push([`sxc${n}.name`, 'S'], [`sxc${n}.pc`, 'D'], [`sxc${n}.pw`, 'D'], [`sxc${n}.pr`, 'F']);
  for (let n = 0; n <= 32; n++) s.push([`sxl${n}.p`, 'D'], [`sxl${n}.dot`, 'D'], [`sxl${n}.pich`, 'D'], [`sxl${n}.prt`, 'D']);
  for (let n = 0; n <= 32; n++) { s.push([`sxl${n}.name`, 'S'], [`sxl${n}.seg`, 'D']); for (let j = 1; j <= 10; j++) s.push([`sxl${n}.pitch${j}`, 'F']); }
  for (let i = 1; i <= 10; i++) s.push([`moji${i}.x`, 'F'], [`moji${i}.y`, 'F'], [`moji${i}.d`, 'F'], [`moji${i}.c`, 'D']);
  s.push(['mojiSizeX', 'F'], ['mojiSizeY', 'F'], ['mojiKankaku', 'F'], ['mojiColor', 'D'], ['mojiShu', 'D'], ['mojiSeiriGyou', 'F'], ['mojiSeiriSuu', 'F'],
    ['mojiZureOn', 'D'], ['zureX0', 'F'], ['zureX1', 'F'], ['zureX2', 'F'], ['zureY0', 'F'], ['zureY1', 'F'], ['zureY2', 'F']);
  return s;
}
const HEADER_SPEC = headerSpec();

export function readHeader(r) {
  const sig = String.fromCharCode(...r.raw(8));
  if (sig !== 'JwwData.') throw new Error('not a JWW file');
  const h = { version: r.u32() };
  for (const [k, t] of HEADER_SPEC) h[k] = t === 'D' ? r.u32() : t === 'F' ? r.f64() : r.cstrRaw();
  return h;
}
export function writeHeader(w, h) {
  w.ascii('JwwData.'); w.u32(600);
  for (const [k, t] of HEADER_SPEC) {
    const v = h[k];
    if (t === 'D') w.u32(v | 0); else if (t === 'F') w.f64(+v); else w.cstr(v == null ? '' : v);
  }
}

// ---------- entity list (MFC CObList of CData*) ----------
const SCHEMA = 600;
export class ObjectWriter {
  constructor(w) { this.w = w; this.classIdx = new Map(); this.next = 1; }
  tag(cls) {
    const w = this.w, idx = this.classIdx.get(cls);
    if (idx === undefined) {
      w.u16(0xFFFF); w.u16(SCHEMA); w.u16(cls.length); w.ascii(cls);
      this.classIdx.set(cls, this.next++);
    } else if (idx < 0x7FFF) {
      w.u16(0x8000 | idx);
    } else { w.u16(0x7FFF); w.u32((0x80000000 | idx) >>> 0); }
    this.next++; // the object itself takes a map index
  }
}
function base(w, e, style, color, width) {
  w.u32(e.group || 0); w.u8w(style); w.u16(color); w.u16(width); w.u16(e.layer || 0); w.u16(e.glayer || 0); w.u16(e.flag || 0);
}
export function writeEntity(ow, e) {
  const w = ow.w;
  switch (e.t) {
    case 'sen':
      ow.tag('CDataSen'); base(w, e, e.style || 1, e.color || 2, e.width || 0);
      w.f64(e.x1); w.f64(e.y1); w.f64(e.x2); w.f64(e.y2); break;
    case 'enko':
      ow.tag('CDataEnko'); base(w, e, e.style || 1, e.color || 2, e.width || 0);
      w.f64(e.cx); w.f64(e.cy); w.f64(e.r); w.f64(e.start); w.f64(e.sweep); w.f64(e.tilt ?? 0); w.f64(e.flat ?? 1); w.u32(e.full ? 1 : 0); break;
    case 'ten':
      ow.tag('CDataTen'); base(w, e, e.code ? 100 : (e.style ?? 1), e.color ?? 2, e.width || 0);
      w.f64(e.x); w.f64(e.y); w.u32(e.kari ? 1 : 0);
      if (e.code) { w.u32(e.code); w.f64(e.rot ?? 0); w.f64(e.scale ?? 0); }
      break;
    case 'moji':
      ow.tag('CDataMoji'); base(w, e, e.style ?? 1, e.color ?? 2, e.width || 0);
      w.f64(e.x1); w.f64(e.y1); w.f64(e.x2); w.f64(e.y2); w.u32(e.shu || 0);
      w.f64(e.sx); w.f64(e.sy); w.f64(e.kankaku ?? 0); w.f64(e.angle ?? 0); w.cstr(e.font || 'ＭＳ ゴシック'); w.cstr(e.text); break;
    case 'solid':
      ow.tag('CDataSolid'); base(w, e, e.style ?? 1, e.rgb != null ? 10 : (e.color ?? 2), e.width || 0);
      w.f64(e.p[0][0]); w.f64(e.p[0][1]); w.f64(e.p[3][0]); w.f64(e.p[3][1]); w.f64(e.p[1][0]); w.f64(e.p[1][1]); w.f64(e.p[2][0]); w.f64(e.p[2][1]);
      if (e.rgb != null) w.u32(e.rgb);
      break;
    default: throw new Error('unknown entity ' + e.t);
  }
}

// entities: an array, or any iterable together with its count (the count is written first)
export function writeJww(header, entities, count = entities.length) {
  const w = new ByteWriter(1 << 20);
  writeHeader(w, header);
  w.count(count);
  const ow = new ObjectWriter(w);
  let n = 0;
  for (const e of entities) { writeEntity(ow, e); n++; }
  if (n !== count) throw new Error(`entity count mismatch: ${n} written, ${count} declared`);
  w.count(0); // no block definitions (blocks are exploded)
  return w.result();
}

// ---------- reading entities (version 600 drawings without block definitions or dimensions) ----------
// Returns { header, entities, blockCount }. Strings stay as Shift_JIS bytes (Uint8Array) so a
// re-serialized file is byte-identical; decode them with new TextDecoder('shift_jis').
export function readJww(u8) {
  const r = new ByteReader(u8);
  const header = readHeader(r);
  if (header.version !== 600) throw new Error('JWW version ' + header.version + ' is not supported by this reader');
  const base = () => ({ group: r.u32(), style: r.u8r(), color: r.u16(), width: r.u16(), layer: r.u16(), glayer: r.u16(), flag: r.u16() });
  const n = r.count();
  const classes = []; let idx = 1; const entities = [];
  for (let i = 0; i < n; i++) {
    const w = r.u16(); let cls;
    if (w === 0xFFFF) { r.u16(); const len = r.u16(); cls = String.fromCharCode(...r.raw(len)); classes[idx] = cls; idx++; }
    else if (w === 0x7FFF) { cls = classes[r.u32() & 0x7FFFFFFF]; }
    else if (w & 0x8000) cls = classes[w & 0x7FFF];
    else throw new Error('unexpected object tag ' + w);
    idx++;
    const b = base(); let e;
    if (cls === 'CDataSen') e = { t: 'sen', ...b, x1: r.f64(), y1: r.f64(), x2: r.f64(), y2: r.f64() };
    else if (cls === 'CDataEnko') e = { t: 'enko', ...b, cx: r.f64(), cy: r.f64(), r: r.f64(), start: r.f64(), sweep: r.f64(), tilt: r.f64(), flat: r.f64(), full: r.u32() };
    else if (cls === 'CDataTen') { e = { t: 'ten', ...b, x: r.f64(), y: r.f64(), kari: r.u32() }; if (b.style === 100) { e.code = r.u32(); e.rot = r.f64(); e.scale = r.f64(); } }
    else if (cls === 'CDataMoji') e = { t: 'moji', ...b, x1: r.f64(), y1: r.f64(), x2: r.f64(), y2: r.f64(), shu: r.u32(), sx: r.f64(), sy: r.f64(), kankaku: r.f64(), angle: r.f64(), font: r.cstrRaw(), text: r.cstrRaw() };
    else if (cls === 'CDataSolid') { const q = [r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64()]; e = { t: 'solid', ...b, p: [[q[0], q[1]], [q[4], q[5]], [q[6], q[7]], [q[2], q[3]]] }; if (b.color === 10) e.rgb = r.u32(); }
    else throw new Error('unsupported object ' + cls);
    entities.push(e);
  }
  const blockCount = r.count();
  return { header, entities, blockCount, end: r.pos };
}
