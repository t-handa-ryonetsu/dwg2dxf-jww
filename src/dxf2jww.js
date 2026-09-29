// DXF (ASCII) → JWW converter. Blocks and dimensions are exploded into lines, arcs, text, points and solids.
import { writeJww } from './jww.js';
import DEFAULT_HEADER from './jww-header.js';
import earcut from './earcut.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- DXF reading
const CODEPAGES = { ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5', ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252', ANSI_1253: 'windows-1253', ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255', ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257', ANSI_1258: 'windows-1258', ANSI_874: 'windows-874', DOS932: 'shift_jis' };

function sniff(u8) {
  const head = new TextDecoder('latin1').decode(u8.subarray(0, Math.min(u8.length, 200000)));
  const ver = (head.match(/\$ACADVER\s*\r?\n\s*1\s*\r?\n([^\r\n]*)/) || [])[1];
  const cp = (head.match(/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n([^\r\n]*)/) || [])[1];
  return { ver: (ver || '').trim(), cp: (cp || '').trim().toUpperCase() };
}
function decodeDxf(u8) {
  if (u8.length > 22 && new TextDecoder('latin1').decode(u8.subarray(0, 22)).startsWith('AutoCAD Binary DXF')) throw new Error('バイナリ形式のDXFには対応していません');
  const { ver, cp } = sniff(u8);
  const verNum = parseInt((ver || 'AC1015').slice(2), 10) || 1015;
  let enc = verNum >= 1021 ? 'utf-8' : (CODEPAGES[cp] || 'shift_jis');
  if (enc !== 'utf-8') {
    // Many exporters write UTF-8 regardless of the code page; prefer it when the bytes are valid UTF-8 with non-ASCII content
    try { const t = new TextDecoder('utf-8', { fatal: true }).decode(u8); if (/[^\x00-\x7F]/.test(t)) return { text: t, ver: verNum, enc: 'utf-8' }; } catch { }
  }
  return { text: new TextDecoder(enc).decode(u8), ver: verNum, enc };
}

// Tokenise into [code, value] pairs
function* pairs(text) {
  let i = 0; const n = text.length;
  const line = () => { let j = text.indexOf('\n', i); if (j < 0) j = n; let s = text.slice(i, j); i = j + 1; if (s.endsWith('\r')) s = s.slice(0, -1); return s; };
  while (i < n) {
    const c = line(); if (i > n && c.trim() === '') break;
    const v = line();
    const code = parseInt(c, 10);
    if (Number.isNaN(code)) continue;
    yield [code, v];
  }
}

// Entities as {type, g: [[code,value]...], children?: []}
function parseDxf(text) {
  const header = {}; const layers = new Map(); const blocks = new Map(); const entities = []; const ltypes = new Map();
  let section = null, cur = null, curBlock = null, table = null, headerVar = null;
  let parent = null; // POLYLINE / INSERT collecting VERTEX / ATTRIB
  const pushEntity = (e) => {
    if (curBlock) curBlock.entities.push(e); else if (section === 'ENTITIES') entities.push(e);
  };
  const finish = () => {
    if (!cur) return;
    const e = cur; cur = null;
    if (section === 'TABLES') {
      if (e.type === 'LAYER') {
        const name = gv(e, 2); if (name != null) layers.set(name, { name, color: +(gv(e, 62) ?? 7), flags: +(gv(e, 70) ?? 0), ltype: gv(e, 6) || 'CONTINUOUS', tc: gv(e, 420) });
      } else if (e.type === 'LTYPE') { const name = gv(e, 2); if (name) ltypes.set(name.toUpperCase(), e); }
      return;
    }
    if (section === 'BLOCKS' && e.type === 'BLOCK') {
      curBlock = { name: gv(e, 2), bx: +(gv(e, 10) || 0), by: +(gv(e, 20) || 0), flags: +(gv(e, 70) || 0), entities: [] };
      return;
    }
    if (section === 'BLOCKS' && e.type === 'ENDBLK') { if (curBlock) blocks.set(curBlock.name, curBlock); curBlock = null; return; }
    if (section !== 'ENTITIES' && section !== 'BLOCKS') return;
    if (e.type === 'VERTEX' || e.type === 'ATTRIB') { if (parent) { parent.children.push(e); return; } }
    if (e.type === 'SEQEND') { parent = null; return; }
    if (e.type === 'POLYLINE' || (e.type === 'INSERT' && +(gv(e, 66) || 0) === 1)) { e.children = []; parent = e; pushEntity(e); return; }
    parent = null; pushEntity(e);
  };
  for (const [code, v] of pairs(text)) {
    if (code === 0) {
      finish();
      if (v === 'SECTION') { section = '?'; continue; }
      if (v === 'ENDSEC') { section = null; continue; }
      if (v === 'EOF') break;
      if (section === 'HEADER') continue;
      if (v === 'TABLE' || v === 'ENDTAB') continue;
      cur = { type: v, g: [] };
      continue;
    }
    if (section === '?' && code === 2) { section = v.trim(); continue; }
    if (section === 'HEADER') {
      if (code === 9) { headerVar = v.trim(); header[headerVar] = header[headerVar] || {}; }
      else if (headerVar) header[headerVar][code] = v;
      continue;
    }
    if (cur) cur.g.push([code, v]);
  }
  finish();
  return { header, layers, blocks, entities, ltypes };
}
function gv(e, code) { for (const p of e.g) if (p[0] === code) return p[1]; return undefined; }
function gn(e, code, d = 0) { const v = gv(e, code); if (v === undefined) return d; const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function gall(e, code) { const r = []; for (const p of e.g) if (p[0] === code) r.push(p[1]); return r; }

// ---------------------------------------------------------------- geometry helpers
// 2D affine: [a, b, c, d, e, f] → x' = a x + c y + e ; y' = b x + d y + f
const I = [1, 0, 0, 1, 0, 0];
function mul(m, n) { return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]; }
function ap(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
function av(m, x, y) { return [m[0] * x + m[2] * y, m[1] * x + m[3] * y]; }
const det = (m) => m[0] * m[3] - m[1] * m[2];
function ocs(e) { return gn(e, 230, 1) < 0 ? [-1, 0, 0, 1, 0, 0] : I; } // extrusion (0,0,-1): mirrored X

// ---------------------------------------------------------------- colours / line types
const JW_BY_HUE = [[0, 8], [60, 4], [120, 3], [180, 1], [240, 6], [300, 5], [360, 8]];
function aciRgb(i) {
  const base = { 1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255], 5: [0, 0, 255], 6: [255, 0, 255], 7: [0, 0, 0], 8: [128, 128, 128], 9: [192, 192, 192] };
  if (base[i]) return base[i];
  if (i >= 250) { const v = [51, 91, 132, 173, 214, 255][i - 250]; return [v, v, v]; }
  if (i >= 10 && i < 250) {
    const hue = Math.floor((i - 10) / 10) * 15, k = (i - 10) % 10;
    const val = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3][k], sat = k % 2 ? 0.5 : 1;
    return hsv(hue, sat, val);
  }
  return [0, 0, 0];
}
function hsv(h, s, v) { const f = (n) => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); }; return [f(5), f(3), f(1)]; }
function rgbToJw([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn < 40) return mx > 150 && mx < 235 ? 9 : 2; // greys and black/white
  let h; const d = mx - mn;
  if (mx === r) h = 60 * (((g - b) / d) % 6); else if (mx === g) h = 60 * ((b - r) / d + 2); else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  let best = 2, bd = 1e9; for (const [hh, c] of JW_BY_HUE) { const dd = Math.abs(h - hh); if (dd < bd) { bd = dd; best = c; } }
  return best;
}
function aciToJw(i) { const t = { 1: 8, 2: 4, 3: 3, 4: 1, 5: 6, 6: 5, 7: 2, 8: 9, 9: 9 }; return t[i] || rgbToJw(aciRgb(i)); }
function ltypeToJw(name) {
  const n = (name || '').toUpperCase();
  if (!n || n === 'CONTINUOUS' || n === 'BYLAYER' || n === 'BYBLOCK') return 1;
  if (/DIVIDE|PHANTOM|DASHDOTDOT|二点/.test(n)) return 7;
  if (/DASHDOT|CENTER|CHAIN|一点/.test(n)) return 5;
  if (/HIDDEN|DASHED|DASH|破線/.test(n)) return 2;
  if (/DOT|点線/.test(n)) return 4;
  return 1;
}

// ---------------------------------------------------------------- text helpers
function decodeEscapes(s) {
  s = s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\M\+([1-5])([0-9A-Fa-f]{4})/g, (_, n, h) => {
    const enc = { 1: 'shift_jis', 2: 'big5', 3: 'euc-kr', 4: 'euc-kr', 5: 'gbk' }[n];
    try { return new TextDecoder(enc).decode(new Uint8Array([parseInt(h.slice(0, 2), 16), parseInt(h.slice(2), 16)])); } catch { return '?'; }
  });
  return s;
}
function textSpecials(s) {
  return decodeEscapes(s).replace(/%%([cCdDpP])/g, (_, c) => ({ c: 'φ', d: '°', p: '±' })[c.toLowerCase()])
    .replace(/%%[uUoOkK]/g, '').replace(/%%(\d{3})/g, (_, n) => String.fromCharCode(+n)).replace(/%%%/g, '%');
}
function mtextLines(raw) {
  let s = decodeEscapes(raw);
  s = s.replace(/\\\\/g, '\u0001').replace(/\\\{/g, '\u0002').replace(/\\\}/g, '\u0003');
  s = s.replace(/\\[pP](?=[^;]*;)[^;]*;/g, (m) => (m === '\\P;' ? '\n' : ''))
    .replace(/\\P/g, '\n').replace(/\\N/g, '\n').replace(/\\X/g, '\n')
    .replace(/\\[fFHhWwQqTtAaCcpP][^;]*;/g, '')
    .replace(/\\[LlOoKk]/g, '').replace(/\\~/g, ' ')
    .replace(/\\S([^;]*?)[\^\/#]([^;]*);/g, '$1/$2')
    .replace(/[{}]/g, '');
  s = s.replace(/\u0001/g, '\\').replace(/\u0002/g, '{').replace(/\u0003/g, '}');
  return textSpecials(s).split('\n');
}
// width of text in "full-width cells" (half-width characters count 0.5)
function cells(str) { let c = 0; for (const ch of str) { const cp = ch.codePointAt(0); c += (cp < 0x80 || (cp >= 0xFF61 && cp <= 0xFF9F)) ? 0.5 : 1; } return c; }

// ---------------------------------------------------------------- compact line storage
class LineStore {
  constructor() { this.n = 0; this.cap = 0; this.xy = new Float64Array(0); this.layer = new Uint16Array(0); this.color = new Uint8Array(0); this.style = new Uint8Array(0); this.flag = new Uint8Array(0); }
  grow() {
    const cap = Math.max(1024, this.cap * 2);
    const xy = new Float64Array(cap * 4); xy.set(this.xy); this.xy = xy;
    const la = new Uint16Array(cap); la.set(this.layer); this.layer = la;
    const co = new Uint8Array(cap); co.set(this.color); this.color = co;
    const st = new Uint8Array(cap); st.set(this.style); this.style = st;
    const fl = new Uint8Array(cap); fl.set(this.flag); this.flag = fl;
    this.cap = cap;
  }
  push(x1, y1, x2, y2, layer, color, style, flag = 0) {
    if (this.n === this.cap) this.grow();
    const o = this.n * 4; this.xy[o] = x1; this.xy[o + 1] = y1; this.xy[o + 2] = x2; this.xy[o + 3] = y2;
    this.layer[this.n] = layer; this.color[this.n] = color; this.style[this.n] = style; this.flag[this.n] = flag; this.n++;
  }
  truncate(n) { if (n < this.n) this.n = n; }
}

// ---------------------------------------------------------------- converter
export function convertDxfToJww(u8, opts = {}) {
  const dec = decodeDxf(u8); const { ver, enc } = dec;
  const dxf = parseDxf(dec.text);
  const stats = { byType: {}, skipped: {}, warnings: [], hatchLines: 0, hatchDense: 0, hatchOutlined: 0, hatchSkipped: 0, dimRedrawn: 0, missingBlocks: new Set() };
  const skip = (t) => { stats.skipped[t] = (stats.skipped[t] || 0) + 1; };

  // units → mm
  const ins = parseInt(dxf.header.$INSUNITS?.[70] ?? '0', 10);
  const UNIT_MM = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 7: 1e6, 8: 0.0000254, 9: 0.0254, 10: 914.4, 14: 100, 15: 10000 };
  const UNIT_NAME = { 1: 'インチ', 2: 'フィート', 7: 'km', 8: 'マイクロインチ', 9: 'ミル', 10: 'ヤード', 14: 'デシメートル', 15: 'デカメートル' };
  const FORCED = { mm: 1, cm: 10, m: 1000, inch: 25.4 };
  let unitMM;
  if (FORCED[opts.units]) unitMM = FORCED[opts.units];
  else if (ins === 4 || ins === 5 || ins === 6) unitMM = UNIT_MM[ins];
  else {
    unitMM = 1; // unitless or imperial label: treat as mm (common for drawings made from AutoCAD's default template)
    if (UNIT_NAME[ins]) stats.warnings.push(`図面の単位が「${UNIT_NAME[ins]}」になっていますが、mm として扱いました（「図面の単位」の設定で変えられます）`);
  }

  // layers
  const layerOrder = []; const layerIdx = new Map();
  const useLayer = (name) => {
    if (!layerIdx.has(name)) { layerIdx.set(name, layerOrder.length); layerOrder.push(name); }
    return layerIdx.get(name);
  };
  const layerInfo = (name) => dxf.layers.get(name) || { color: 7, flags: 0, ltype: 'CONTINUOUS' };

  // Lines (by far the most numerous, e.g. hatch patterns) are kept in typed arrays; other shapes as objects. Model mm.
  const lines = new LineStore();
  const prims = []; // {k:'arc'|'point'|'text'|'solid', layer, color, style, ...}
  const MAX_TOTAL = opts.maxElements || 8000000;
  let truncated = false;
  const full = () => { if (lines.n + prims.length >= MAX_TOTAL) { truncated = true; return true; } return false; };
  const add = (p) => { if (!full()) { if (inPattern) p.fromPattern = true; prims.push(p); } };
  let inPattern = false; // while generating hatch pattern lines
  const hatchBoxes = []; // [minx, miny, maxx, maxy] of each hatch, in model coordinates

  // resolve colour/linetype/layer with BYBLOCK inheritance
  function attrs(e, ctx) {
    let layer = gv(e, 8) ?? '0';
    if (layer === '0' && ctx.layer) layer = ctx.layer;
    const li = layerInfo(layer);
    let aci = gv(e, 62) !== undefined ? parseInt(gv(e, 62), 10) : 256;
    const tc = gv(e, 420);
    const tcRgb = (v) => [(+v >> 16) & 255, (+v >> 8) & 255, +v & 255];
    let color;
    if (aci === 0) color = ctx.color ?? 2; // BYBLOCK
    else if (tc !== undefined) color = rgbToJw(tcRgb(tc));
    else if (aci === 256) color = li.tc !== undefined ? rgbToJw(tcRgb(li.tc)) : aciToJw(Math.abs(li.color) || 7);
    else color = aciToJw(Math.abs(aci));
    let lt = gv(e, 6) || 'BYLAYER';
    let style;
    if (/^BYBLOCK$/i.test(lt)) style = ctx.style ?? 1;
    else if (/^BYLAYER$/i.test(lt)) style = ltypeToJw(li.ltype);
    else style = ltypeToJw(lt);
    const rgbAci = aci === 0 ? (ctx.rgb ?? [0, 0, 0]) : aci === 256 ? aciRgb(Math.abs(li.color) || 7) : aciRgb(Math.abs(aci));
    const rgb = tc !== undefined ? tcRgb(tc) : rgbAci;
    return { layer: useLayer(layer), layerName: layer, color, style, rgb };
  }

  function line(m, a, x1, y1, x2, y2) {
    const [ax, ay] = ap(m, x1, y1), [bx, by] = ap(m, x2, y2);
    if (!isFinite(ax + ay + bx + by)) return;
    if (!full()) lines.push(ax, ay, bx, by, a.layer, a.color, a.style, inPattern ? 1 : 0);
  }
  // ellipse arc: P(t) = c + u cos t + v sin t, t from t0 to t1 (CCW)
  function earc(m, a, cx, cy, ux, uy, vx, vy, t0, t1, full) {
    let [Cx, Cy] = ap(m, cx, cy); let [Ux, Uy] = av(m, ux, uy); let [Vx, Vy] = av(m, vx, vy);
    if (Ux * Vy - Uy * Vx < 0) { Vx = -Vx; Vy = -Vy; const s = t0; t0 = -t1; t1 = -s; }
    const uu = Ux * Ux + Uy * Uy, vv = Vx * Vx + Vy * Vy, uv = Ux * Vx + Uy * Vy;
    const phi = 0.5 * Math.atan2(2 * uv, uu - vv);
    const cp = Math.cos(phi), sp = Math.sin(phi);
    let Ax = Ux * cp + Vx * sp, Ay = Uy * cp + Vy * sp, Bx = -Ux * sp + Vx * cp, By = -Uy * sp + Vy * cp;
    t0 -= phi; t1 -= phi;
    let ra = Math.hypot(Ax, Ay), rb = Math.hypot(Bx, By);
    if (rb > ra) { const nx = Bx, ny = By; Bx = -Ax; By = -Ay; Ax = nx; Ay = ny; t0 -= Math.PI / 2; t1 -= Math.PI / 2; const t = ra; ra = rb; rb = t; }
    if (!(ra > 0) || !isFinite(ra + Cx + Cy)) return;
    let sweep = t1 - t0; if (full) sweep = TAU;
    let start = ((t0 % TAU) + TAU) % TAU;
    add({ k: 'arc', ...a, cx: Cx, cy: Cy, r: ra, flat: rb / ra, tilt: Math.atan2(Ay, Ax), start: full ? 0 : start, sweep, full: !!full });
  }
  function bulgeArc(m, a, x1, y1, x2, y2, b) {
    if (Math.abs(b) < 1e-9) return line(m, a, x1, y1, x2, y2);
    const th = 4 * Math.atan(b), dx = x2 - x1, dy = y2 - y1, ch = Math.hypot(dx, dy);
    if (ch === 0) return;
    const r = ch / (2 * Math.sin(Math.abs(th) / 2));
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, h = r * Math.cos(Math.abs(th) / 2);
    const nx = -dy / ch, ny = dx / ch, sgn = b > 0 ? 1 : -1;
    const cx = mx + nx * h * sgn, cy = my + ny * h * sgn;
    let a1 = Math.atan2(y1 - cy, x1 - cx), a2 = Math.atan2(y2 - cy, x2 - cx);
    if (b < 0) { const t = a1; a1 = a2; a2 = t; }
    if (a2 <= a1) a2 += TAU;
    earc(m, a, cx, cy, r, 0, 0, r, a1, a2, false);
  }
  function text(m, a, x, y, h, wf, rotDeg, str, ha = 0, va = 0) {
    if (!str || !str.trim()) return;
    const r = rotDeg * Math.PI / 180;
    const [dx, dy] = av(m, Math.cos(r), Math.sin(r)); const [px, py] = av(m, -Math.sin(r), Math.cos(r));
    const sw = Math.hypot(dx, dy), sh = Math.hypot(px, py);
    let H = h * sh, WF = wf * (sw / (sh || 1));
    let [X, Y] = ap(m, x, y);
    const ux = dx / (sw || 1), uy = dy / (sw || 1), nx = px / (sh || 1), ny = py / (sh || 1);
    const width = cells(str) * H * WF;
    const shiftX = ha === 1 || ha === 4 ? -width / 2 : ha === 2 ? -width : 0;
    const shiftY = va === 2 ? -H / 2 : va === 3 ? -H : 0;
    X += ux * shiftX + nx * shiftY; Y += uy * shiftX + ny * shiftY;
    let ang = Math.atan2(uy, ux);
    if (ux * ny - uy * nx < 0) { X += ux * width; Y += uy * width; ang += Math.PI; } // mirrored: keep the text readable
    if (!isFinite(X + Y + H) || H <= 0) return;
    add({ k: 'text', ...a, x: X, y: Y, h: H, wf: WF, ang, str, width });
  }

  const warnOnce = new Set();
  function warn(msg) { if (!warnOnce.has(msg)) { warnOnce.add(msg); stats.warnings.push(msg); } }

  const sources = {}; // elements produced, by source entity type (inner entities of blocks counted separately)
  function explode(list, m, ctx, depth) {
    if (depth > 20) { warn('ブロックの入れ子が深すぎるため一部を省略しました'); return; }
    for (const e of list) {
      const before = lines.n + prims.length;
      try { conv(e, m, ctx, depth); } catch (err) { skip(e.type + '（読み取りエラー）'); }
      if (e.type !== 'INSERT' && e.type !== 'DIMENSION' && e.type !== 'ACAD_TABLE') sources[e.type] = (sources[e.type] || 0) + lines.n + prims.length - before;
      if (truncated) return;
    }
  }

  function conv(e, M, ctx, depth) {
    if (gn(e, 67, 0) === 1) return; // paper space
    const t = e.type;
    if (t === 'ATTDEF') return;
    const a = attrs(e, ctx);
    const m = mul(M, ocs(e));
    switch (t) {
      case 'LINE': return line(M, a, gn(e, 10), gn(e, 20), gn(e, 11), gn(e, 21));
      case 'CIRCLE': { const r = gn(e, 40); return earc(m, a, gn(e, 10), gn(e, 20), r, 0, 0, r, 0, TAU, true); }
      case 'ARC': {
        const r = gn(e, 40); let s = gn(e, 50) * Math.PI / 180, en = gn(e, 51) * Math.PI / 180;
        if (en <= s) en += TAU;
        return earc(m, a, gn(e, 10), gn(e, 20), r, 0, 0, r, s, en, false);
      }
      case 'ELLIPSE': {
        const ux = gn(e, 11), uy = gn(e, 21), ratio = gn(e, 40, 1); let s = gn(e, 41, 0), en = gn(e, 42, TAU);
        const full = Math.abs(en - s - TAU) < 1e-6 || (s === 0 && Math.abs(en - TAU) < 1e-6);
        if (en <= s) en += TAU;
        const flip = gn(e, 230, 1) < 0 ? -1 : 1; // ELLIPSE is in WCS; a negative extrusion runs it clockwise
        return earc(M, a, gn(e, 10), gn(e, 20), ux, uy, -uy * ratio * flip, ux * ratio * flip, s, en, full);
      }
      case 'POINT': { const [x, y] = ap(M, gn(e, 10), gn(e, 20)); return add({ k: 'point', ...a, x, y }); }
      case 'LWPOLYLINE': {
        const xs = gall(e, 10).map(Number), ys = gall(e, 20).map(Number);
        const bul = new Array(xs.length).fill(0); let vi = -1;
        for (const [c, v] of e.g) { if (c === 10) vi++; else if (c === 42 && vi >= 0) bul[vi] = +v; }
        const closed = (gn(e, 70) & 1) === 1;
        const n = xs.length;
        for (let i = 0; i < n - 1 + (closed ? 1 : 0); i++) { const j = (i + 1) % n; bulgeArc(m, a, xs[i], ys[i], xs[j], ys[j], bul[i]); }
        return;
      }
      case 'POLYLINE': {
        const fl = gn(e, 70);
        if (fl & 16 || fl & 64) { // mesh / polyface: draw edges of faces approximately
          const vs = e.children.filter((v) => (gn(v, 70) & 64) || !(gn(v, 70) & 128));
          const pts = vs.map((v) => [gn(v, 10), gn(v, 20)]);
          for (const v of e.children) {
            if ((gn(v, 70) & 128) && !(gn(v, 70) & 64)) {
              const idx = [71, 72, 73, 74].map((c) => gn(v, c)).filter((k) => k !== 0);
              for (let i = 0; i < idx.length; i++) {
                if (idx[i] < 0) continue; // negative index: invisible edge
                const p = pts[Math.abs(idx[i]) - 1], q = pts[Math.abs(idx[(i + 1) % idx.length]) - 1];
                if (p && q) line(M, a, p[0], p[1], q[0], q[1]);
              }
            }
          }
          if (!e.children.some((v) => gn(v, 70) & 128)) for (let i = 0; i + 1 < pts.length; i++) line(M, a, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
          return;
        }
        const is3d = (fl & 8) === 8;
        const vs = e.children.filter((v) => !(gn(v, 70) & 16)); // skip spline frame control points
        const closed = (fl & 1) === 1, n = vs.length;
        const mm = is3d ? M : m;
        for (let i = 0; i < n - 1 + (closed ? 1 : 0); i++) {
          const p = vs[i], q = vs[(i + 1) % n];
          if (is3d) line(mm, a, gn(p, 10), gn(p, 20), gn(q, 10), gn(q, 20));
          else bulgeArc(mm, a, gn(p, 10), gn(p, 20), gn(q, 10), gn(q, 20), gn(p, 42));
        }
        return;
      }
      case 'SPLINE': {
        const pts = simplify(splinePoints(e));
        for (let i = 0; i + 1 < pts.length; i++) line(M, a, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        return;
      }
      case 'TEXT': case 'ATTRIB': {
        if (t === 'ATTRIB' && (gn(e, 70) & 1)) return; // invisible
        const ha = gn(e, 72), va = gn(e, t === 'ATTRIB' ? 74 : 73);
        let x = gn(e, 10), y = gn(e, 20); const h = gn(e, 40, 2.5); let wf = gn(e, 41, 1) || 1; let rot = gn(e, 50);
        const str = textSpecials(gv(e, 1) || '');
        if ((ha || va) && gv(e, 11) !== undefined) {
          if (ha === 3 || ha === 5) { // aligned / fit between the two points
            const x2 = gn(e, 11), y2 = gn(e, 21); rot = Math.atan2(y2 - y, x2 - x) * 180 / Math.PI;
            const len = Math.hypot(x2 - x, y2 - y), c = cells(str);
            if (c > 0 && len > 0) { if (ha === 5) wf = len / (c * h); else { return text(m, a, x, y, Math.min(h, len / c), 1, rot, str, 0, 0); } }
            return text(m, a, x, y, h, wf, rot, str, 0, 0);
          }
          x = gn(e, 11); y = gn(e, 21);
        }
        return text(m, a, x, y, h, wf, rot, str, ha, va);
      }
      case 'MTEXT': {
        let raw = gall(e, 3).join('') + (gv(e, 1) || '');
        const lines = mtextLines(raw);
        const h = gn(e, 40, 2.5), att = gn(e, 71, 1) || 1;
        let rot = gn(e, 50, NaN);
        if (!Number.isFinite(rot)) { const dx = gn(e, 11, 1), dy = gn(e, 21, 0); rot = Math.atan2(dy, dx) * 180 / Math.PI; }
        const spacing = h * 1.667 * (gn(e, 44, 1) || 1);
        const x = gn(e, 10), y = gn(e, 20);
        const r = rot * Math.PI / 180, ux = Math.cos(r), uy = Math.sin(r), nx = -uy, ny = ux;
        const col = (att - 1) % 3, row = Math.floor((att - 1) / 3);
        const total = h + spacing * (lines.length - 1);
        const top = row === 0 ? 0 : row === 1 ? total / 2 : total;
        lines.forEach((ln, i) => {
          const dy = top - h - spacing * i; // baseline offset from insertion along normal
          const bx = x + nx * dy, by = y + ny * dy;
          text(M, a, bx, by, h, 1, rot, ln, col === 1 ? 1 : col === 2 ? 2 : 0, 0);
        });
        return;
      }
      case 'SOLID': case 'TRACE': case '3DFACE': {
        const p = [[gn(e, 10), gn(e, 20)], [gn(e, 11), gn(e, 21)], [gn(e, 12), gn(e, 22)], [gv(e, 13) !== undefined ? gn(e, 13) : gn(e, 12), gv(e, 23) !== undefined ? gn(e, 23) : gn(e, 22)]];
        if (t === '3DFACE') { const q = [p[0], p[1], p[2], p[3]]; for (let i = 0; i < 4; i++) line(M, a, q[i][0], q[i][1], q[(i + 1) % 4][0], q[(i + 1) % 4][1]); return; }
        const mm = t === 'SOLID' || t === 'TRACE' ? m : M;
        return add({ k: 'solid', ...a, p: p.map(([x, y]) => ap(mm, x, y)) });
      }
      case 'INSERT': case 'ACAD_TABLE': {
        const b = dxf.blocks.get(gv(e, 2));
        if (!b) { skip('ブロック（定義なし）'); stats.missingBlocks.add(decodeEscapes(gv(e, 2) || '')); return; }
        const sx = gn(e, 41, 1), sy = gn(e, 42, 1), rot = gn(e, 50) * Math.PI / 180;
        const cols = Math.max(1, gn(e, 70, 1)), rows = Math.max(1, gn(e, 71, 1)), cs = gn(e, 44), rs = gn(e, 45);
        const c = Math.cos(rot), s = Math.sin(rot);
        const bctx = { layer: a.layerName, color: a.color, style: a.style, rgb: a.rgb };
        for (let ri = 0; ri < rows; ri++) for (let ci = 0; ci < cols; ci++) {
          const ox = ci * cs, oy = ri * rs;
          const ix = gn(e, 10) + c * ox - s * oy, iy = gn(e, 20) + s * ox + c * oy;
          let T = [c * sx, s * sx, -s * sy, c * sy, ix, iy];
          T = mul(T, [1, 0, 0, 1, -b.bx, -b.by]);
          explode(b.entities, mul(m, T), bctx, depth + 1);
        }
        if (e.children) for (const at of e.children) conv(at, M, ctx, depth);
        return;
      }
      case 'DIMENSION': case 'ARC_DIMENSION': case 'LARGE_RADIAL_DIMENSION': {
        const b = dxf.blocks.get(gv(e, 2));
        if (!b) { if (!redrawDimension(e, M, a)) skip('寸法（図形なし）'); return; }
        const bctx = { layer: a.layerName, color: a.color, style: a.style, rgb: a.rgb };
        return explode(b.entities, M, bctx, depth + 1);
      }
      case 'LEADER': {
        const xs = gall(e, 10).map(Number), ys = gall(e, 20).map(Number);
        for (let i = 0; i + 1 < xs.length; i++) line(M, a, xs[i], ys[i], xs[i + 1], ys[i + 1]);
        return;
      }
      case 'HATCH': return hatch(e, m, a);
      case 'MULTILEADER': case 'MLEADER': {
        // context data: 304 text, 12/22 text location, 41 text height; LEADER{ 10/20 landing; LEADER_LINE{ 10/20 vertices }
        let mode = '', txt = null, tx = 0, ty = 0, th = 2.5, landing = null, pts = [], rot = 0;
        const leaders = [];
        for (const [c, v] of e.g) {
          if (c === 300 && v.startsWith('CONTEXT_DATA')) mode = 'ctx';
          else if (c === 302 && v.startsWith('LEADER')) { mode = 'leader'; landing = null; }
          else if (c === 304 && v.startsWith('LEADER_LINE')) { mode = 'line'; pts = []; }
          else if (c === 305 && mode === 'line') { leaders.push({ pts, landing }); mode = 'leader'; }
          else if (c === 303 && mode === 'leader') mode = 'ctx';
          else if (mode === 'ctx') {
            if (c === 304) txt = (txt || '') + v; else if (c === 12) tx = +v; else if (c === 22) ty = +v; else if (c === 41) th = +v; else if (c === 42) rot = +v * 180 / Math.PI;
          } else if (mode === 'leader') { if (c === 10) landing = [+v, 0]; else if (c === 20 && landing) landing[1] = +v; }
          else if (mode === 'line') { if (c === 10) pts.push([+v, 0]); else if (c === 20 && pts.length) pts[pts.length - 1][1] = +v; }
        }
        for (const ld of leaders) {
          const all = ld.landing ? [...ld.pts, ld.landing] : ld.pts;
          for (let i = 0; i + 1 < all.length; i++) line(M, a, all[i][0], all[i][1], all[i + 1][0], all[i + 1][1]);
        }
        if (txt) {
          const ls = mtextLines(txt), sp = th * 1.667;
          const r = rot * Math.PI / 180, nx = -Math.sin(r), ny = Math.cos(r);
          ls.forEach((ln, i) => { const d = -th - sp * i; text(M, a, tx + nx * d, ty + ny * d, th, 1, rot, ln, 0, 0); });
        }
        return;
      }
      case 'VIEWPORT': case 'ATTRIB_': case 'SEQEND': case 'XLINE': case 'RAY': return;
      default: skip(t);
    }
  }

  // Linear (rotated) and aligned dimensions drawn from 13/23, 14/24 (extension origins), 10/20 (dimension line)
  function redrawDimension(e, M, a) {
    const type = gn(e, 70) & 7;
    if (type !== 0 && type !== 1) return false;
    const x1 = gn(e, 13), y1 = gn(e, 23), x2 = gn(e, 14), y2 = gn(e, 24), dx = gn(e, 10), dy = gn(e, 20);
    let ang = type === 1 ? Math.atan2(y2 - y1, x2 - x1) : gn(e, 50) * Math.PI / 180;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const proj = (x, y) => { const t = (x - dx) * ux + (y - dy) * uy; return [dx + ux * t, dy + uy * t]; };
    const p1 = proj(x1, y1), p2 = proj(x2, y2);
    if (![...p1, ...p2].every(Number.isFinite)) return false;
    line(M, a, x1, y1, p1[0], p1[1]); line(M, a, x2, y2, p2[0], p2[1]); line(M, a, p1[0], p1[1], p2[0], p2[1]);
    const meas = gv(e, 42) !== undefined ? gn(e, 42) : Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const over = gv(e, 1) || '';
    const value = (Math.round(meas * 100) / 100).toLocaleString('ja-JP');
    const str = over === '' || over === '<>' ? value : over.replace('<>', value);
    const hdr = dxf.header;
    const h = (parseFloat(hdr.$DIMTXT?.[40]) || 2.5) * (parseFloat(hdr.$DIMSCALE?.[40]) || 1);
    const tx = gv(e, 11) !== undefined ? gn(e, 11) : (p1[0] + p2[0]) / 2, ty = gv(e, 21) !== undefined ? gn(e, 21) : (p1[1] + p2[1]) / 2;
    let deg = ang * 180 / Math.PI; if (deg > 90.001 || deg <= -90) deg += 180;
    text(M, a, tx, ty, h, 1, deg, mtextLines(str).join(' '), 1, 2);
    stats.dimRedrawn++;
    return true;
  }

  // ---- HATCH
  function hatchLoops(e) {
    // walk groups after 91 (number of paths)
    const g = e.g; let i = g.findIndex((p) => p[0] === 91); if (i < 0) return [];
    const nPaths = +g[i][1]; i++;
    const loops = [];
    const num = (c) => { while (i < g.length && g[i][0] !== c) i++; return i < g.length ? +g[i++][1] : 0; };
    for (let pth = 0; pth < nPaths && i < g.length; pth++) {
      const flags = num(92); const pts = [];
      if (flags & 2) { // polyline
        const hasB = num(72), closed = num(73), n = num(93);
        const vx = []; for (let k = 0; k < n; k++) { const x = num(10), y = num(20); const b = hasB ? num(42) : 0; vx.push([x, y, b]); }
        for (let k = 0; k < vx.length; k++) { const p = vx[k], q = vx[(k + 1) % vx.length]; arcPoints(p[0], p[1], q[0], q[1], p[2], pts); }
      } else {
        const ne = num(93);
        for (let k = 0; k < ne; k++) {
          const et = num(72);
          if (et === 1) { const x1 = num(10), y1 = num(20), x2 = num(11), y2 = num(21); pts.push([x1, y1], [x2, y2]); }
          else if (et === 2) {
            const cx = num(10), cy = num(20), r = num(40); let s = num(50), en = num(51); const ccw = num(73);
            let a0 = s * Math.PI / 180, a1 = en * Math.PI / 180; if (a1 <= a0) a1 += TAU;
            const seg = Math.max(8, Math.ceil((a1 - a0) / (Math.PI / 24)));
            for (let q = 0; q <= seg; q++) { let t = a0 + (a1 - a0) * q / seg; if (!ccw) t = -t; pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
          } else if (et === 3) {
            const cx = num(10), cy = num(20), mx = num(11), my = num(21), ratio = num(40); let s = num(50), en = num(51); const ccw = num(73);
            let a0 = s * Math.PI / 180, a1 = en * Math.PI / 180; if (a1 <= a0) a1 += TAU;
            const seg = Math.max(12, Math.ceil((a1 - a0) / (Math.PI / 24)));
            for (let q = 0; q <= seg; q++) { let t = a0 + (a1 - a0) * q / seg; if (!ccw) t = -t; const c = Math.cos(t), sn = Math.sin(t); pts.push([cx + mx * c - my * ratio * sn, cy + my * c + mx * ratio * sn]); }
          } else if (et === 4) {
            const deg = num(94); num(73); num(74); const nk = num(95), nc = num(96);
            const knots = []; for (let q = 0; q < nk; q++) knots.push(num(40));
            const ctrl = []; for (let q = 0; q < nc; q++) ctrl.push([num(10), num(20)]);
            const sp = deBoorSample(deg, knots, ctrl, null, Math.max(16, nc * 8)); pts.push(...sp);
          }
        }
      }
      if (pts.length >= 3) loops.push({ pts, outer: !!(flags & 1) });
    }
    return loops;
  }
  function arcPoints(x1, y1, x2, y2, b, out) {
    out.push([x1, y1]);
    if (Math.abs(b) < 1e-9) return;
    const th = 4 * Math.atan(b), dx = x2 - x1, dy = y2 - y1, ch = Math.hypot(dx, dy); if (!ch) return;
    const r = ch / (2 * Math.sin(Math.abs(th) / 2)), h = r * Math.cos(Math.abs(th) / 2), sg = b > 0 ? 1 : -1;
    const cx = (x1 + x2) / 2 - dy / ch * h * sg, cy = (y1 + y2) / 2 + dx / ch * h * sg;
    const a0 = Math.atan2(y1 - cy, x1 - cx); const seg = Math.max(4, Math.ceil(Math.abs(th) / (Math.PI / 24)));
    for (let q = 1; q < seg; q++) { const t = a0 + th * q / seg; out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  }
  function hatch(e, m, a) {
    const loops = hatchLoops(e);
    if (!loops.length) { skip('ハッチング（境界なし）'); return; }
    const solid = gn(e, 70) === 1 || /^SOLID$/i.test(gv(e, 2) || '');
    if (solid) {
      if (opts.fillSolids === false) return;
      // earcut per outer loop with the loops inside it as holes (by containment); simple approach: all loops together with even-odd
      const groups = groupLoops(loops);
      for (const gp of groups) {
        const flat = [], holes = [];
        gp.forEach((lp, k) => { if (k > 0) holes.push(flat.length / 2); for (const p of lp) flat.push(p[0], p[1]); });
        const tri = earcut(flat, holes);
        for (let k = 0; k < tri.length; k += 3) {
          const P = [tri[k], tri[k + 1], tri[k + 2]].map((ix) => ap(m, flat[ix * 2], flat[ix * 2 + 1]));
          add({ k: 'solid', ...a, p: [P[0], P[1], P[2], P[2]], fill: true });
        }
      }
      stats.byType['塗りつぶし'] = (stats.byType['塗りつぶし'] || 0) + 1;
      return;
    }
    // pattern lines
    const mode = opts.hatch || 'lines'; // 'lines' | 'outline' | 'none'
    if (mode === 'none') { stats.hatchSkipped++; return; }
    const outline = () => {
      for (const lp of loops) for (let k = 0; k < lp.pts.length; k++) { const p = lp.pts[k], q = lp.pts[(k + 1) % lp.pts.length]; line(m, a, p[0], p[1], q[0], q[1]); }
    };
    if (mode === 'outline') { outline(); stats.hatchOutlined++; return; }
    const g = e.g; let i = g.findIndex((p) => p[0] === 78);
    if (i < 0) { outline(); stats.hatchOutlined++; return; }
    const nl = +g[i][1]; i++;
    const defs = [];
    for (let k = 0; k < nl; k++) {
      const get = (c) => { while (i < g.length && g[i][0] !== c) i++; return i < g.length ? +g[i++][1] : 0; };
      const ang = get(53), bx = get(43), by = get(44), ox = get(45), oy = get(46), nd = get(79);
      const dashes = []; for (let q = 0; q < nd; q++) dashes.push(get(49));
      defs.push({ ang: ang * Math.PI / 180, bx, by, ox, oy, dashes });
    }
    const edges = []; for (const lp of loops) for (let k = 0; k < lp.pts.length; k++) edges.push([lp.pts[k], lp.pts[(k + 1) % lp.pts.length]]);
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const [p] of edges) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); }
    // A single hatch may not add more than HATCH_MAX pieces; a denser one is drawn as its outline instead
    const HATCH_MAX = opts.hatchMax || 50000;
    const startLines = lines.n, startPrims = prims.length;
    let produced = 0, tooDense = false; const LIMIT = 20000;
    { const P = edges.map(([p]) => ap(m, p[0], p[1])); hatchBoxes.push([Math.min(...P.map((q) => q[0])), Math.min(...P.map((q) => q[1])), Math.max(...P.map((q) => q[0])), Math.max(...P.map((q) => q[1]))]); }
    inPattern = true;
    for (const d of defs) {
      const ux = Math.cos(d.ang), uy = Math.sin(d.ang), nx = -uy, ny = ux;
      const step = d.ox * nx + d.oy * ny; if (Math.abs(step) < 1e-9) continue;
      const shift = d.ox * ux + d.oy * uy;
      const corners = [[minx, miny], [maxx, miny], [minx, maxy], [maxx, maxy]].map(([x, y]) => ((x - d.bx) * nx + (y - d.by) * ny) / step);
      const k0 = Math.floor(Math.min(...corners)), k1 = Math.ceil(Math.max(...corners));
      if (k1 - k0 > LIMIT) { tooDense = true; break; }
      const plen = d.dashes.reduce((s, v) => s + Math.abs(v), 0);
      for (let k = k0; k <= k1 && !tooDense; k++) {
        const Ox = d.bx + k * d.ox, Oy = d.by + k * d.oy;
        const ss = [];
        for (const [p, q] of edges) {
          const dp = (p[0] - Ox) * nx + (p[1] - Oy) * ny, dq = (q[0] - Ox) * nx + (q[1] - Oy) * ny;
          if ((dp > 0) === (dq > 0)) continue;
          const tt = dp / (dp - dq); const X = p[0] + (q[0] - p[0]) * tt, Y = p[1] + (q[1] - p[1]) * tt;
          ss.push((X - Ox) * ux + (Y - Oy) * uy);
        }
        ss.sort((p, q) => p - q);
        for (let j = 0; j + 1 < ss.length; j += 2) {
          const s0 = ss[j], s1 = ss[j + 1];
          if (produced > HATCH_MAX) { tooDense = true; break; }
          if (!d.dashes.length || plen <= 0) { line(m, a, Ox + ux * s0, Oy + uy * s0, Ox + ux * s1, Oy + uy * s1); produced++; continue; }
          let s = Math.floor(s0 / plen) * plen;
          while (s < s1) {
            if (produced > HATCH_MAX) { tooDense = true; break; }
            for (const dl of d.dashes) {
              const len = Math.abs(dl), e0 = s, e1 = s + len; s = e1;
              if (dl < 0 || e1 < s0 || e0 > s1) continue;
              const c0 = Math.max(e0, s0), c1 = Math.min(e1, s1);
              if (len === 0) { if (e0 >= s0 && e0 <= s1) { const [x, y] = ap(m, Ox + ux * e0, Oy + uy * e0); add({ k: 'point', ...a, x, y }); produced++; } continue; }
              if (c1 > c0) { line(m, a, Ox + ux * c0, Oy + uy * c0, Ox + ux * c1, Oy + uy * c1); produced++; }
            }
          }
        }
      }
      if (tooDense) break;
    }
    inPattern = false;
    if (tooDense) { lines.truncate(startLines); prims.length = startPrims; outline(); stats.hatchDense++; return; }
    stats.hatchLines += lines.n - startLines;
    stats.byType['ハッチング'] = (stats.byType['ハッチング'] || 0) + 1;
  }
  function groupLoops(loops) {
    // assign each loop to the smallest loop that contains it; depth even = outer
    const L = loops.map((l) => l.pts);
    const area = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; s += p[i][0] * q[1] - q[0] * p[i][1]; } return Math.abs(s / 2); };
    const inside = (pt, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c; } return c; };
    const idx = L.map((_, i) => i).sort((a, b) => area(L[b]) - area(L[a]));
    const parent = new Array(L.length).fill(-1), depth = new Array(L.length).fill(0);
    for (let x = 0; x < idx.length; x++) {
      const i = idx[x];
      for (let y = x - 1; y >= 0; y--) { const j = idx[y]; if (inside(L[i][0], L[j])) { parent[i] = j; depth[i] = depth[j] + 1; break; } }
    }
    const groups = new Map();
    for (const i of idx) {
      if (depth[i] % 2 === 0) groups.set(i, [L[i]]);
      else if (groups.has(parent[i])) groups.get(parent[i]).push(L[i]);
    }
    return [...groups.values()];
  }

  // ---- run
  explode(dxf.entities, I, {}, 0);
  if (stats.dimRedrawn) warn(`図形データが読めなかった寸法${stats.dimRedrawn}個は、寸法の位置と値から描き直しました`);
  if (stats.hatchDense) warn(`細かいハッチング模様${stats.hatchDense}個は、線が多くなりすぎるため外形線だけにしました`);
  if (truncated) warn(`図形が${(MAX_TOTAL / 10000).toFixed(0)}万個を超えたため、それ以降を省きました。ハッチングの設定を「外形線だけ」か「入れない」にすると減らせます`);

  // ---- scale / paper / placement
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const ext = (x, y) => { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; };
  const LX = lines.xy;
  for (let i = 0; i < lines.n * 4; i += 4) { ext(LX[i], LX[i + 1]); ext(LX[i + 2], LX[i + 3]); }
  for (const p of prims) {
    if (p.k === 'arc') { ext(p.cx - p.r, p.cy - p.r); ext(p.cx + p.r, p.cy + p.r); }
    else if (p.k === 'point' || p.k === 'text') ext(p.x, p.y);
    else if (p.k === 'solid') for (const q of p.p) ext(q[0], q[1]);
  }
  const total = lines.n + prims.length;
  if (!total) { minx = miny = 0; maxx = maxy = 1; }
  // Stray objects far from the drawing would shrink everything: fit to the main cluster when the full extents are much larger
  if (!opts.scale && total > 50) {
    // pattern pieces are not counted (a dense hatch would outweigh the rest); each hatch counts by its box instead
    let xs = new Float64Array(total + hatchBoxes.length * 2), ys = new Float64Array(total + hatchBoxes.length * 2), j = 0;
    for (let i = 0; i < lines.n; i++) { if (lines.flag[i]) continue; const o = i * 4; xs[j] = (LX[o] + LX[o + 2]) / 2; ys[j] = (LX[o + 1] + LX[o + 3]) / 2; j++; }
    for (const p of prims) {
      if (p.fromPattern) continue;
      xs[j] = p.k === 'arc' ? p.cx : p.k === 'solid' ? p.p[0][0] : p.x;
      ys[j] = p.k === 'arc' ? p.cy : p.k === 'solid' ? p.p[0][1] : p.y; j++;
    }
    for (const b of hatchBoxes) { xs[j] = b[0]; ys[j] = b[1]; j++; xs[j] = b[2]; ys[j] = b[3]; j++; }
    xs = xs.subarray(0, j).sort(); ys = ys.subarray(0, j).sort();
    const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(f * (arr.length - 1))))];
    const rx0 = q(xs, 0.005), rx1 = q(xs, 0.995), ry0 = q(ys, 0.005), ry1 = q(ys, 0.995);
    const rw = Math.max(rx1 - rx0, 1e-9), rh = Math.max(ry1 - ry0, 1e-9);
    if ((maxx - minx) > rw * 4 || (maxy - miny) > rh * 4) {
      const mx = rw * 0.08, my = rh * 0.08;
      minx = rx0 - mx; maxx = rx1 + mx; miny = ry0 - my; maxy = ry1 + my;
      warn('図面から大きく離れた位置に図形があります。縮尺は図面の主要部分に合わせました');
    }
  }
  const PAPERS = { 0: [1189, 841], 1: [841, 594], 2: [594, 420], 3: [420, 297], 4: [297, 210] };
  const paper = opts.paper ?? 3;
  const [pw, ph] = PAPERS[paper] || PAPERS[3];
  const wmm = (maxx - minx) * unitMM, hmm = (maxy - miny) * unitMM;
  const SCALES = [1, 2, 2.5, 5, 10, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 750, 1000, 1200, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7500, 10000, 20000, 25000, 50000, 100000];
  let scale = opts.scale;
  if (!scale) { scale = SCALES.find((s) => wmm / s <= pw * 0.9 && hmm / s <= ph * 0.9) || Math.ceil(Math.max(wmm / (pw * 0.9), hmm / (ph * 0.9))); }
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  const k = unitMM / scale;
  const X = (x) => (x - cx) * k, Y = (y) => (y - cy) * k;

  // ---- JWW entities (generated one at a time so millions of lines need no extra objects)
  const layerOf = (li) => { const i = Math.min(li, 255); return { glayer: i >> 4, layer: i & 15 }; };
  const counts = { 線: lines.n, 円弧: 0, 点: 0, 文字: 0, ソリッド: 0 };
  for (const p of prims) counts[{ arc: '円弧', point: '点', text: '文字', solid: 'ソリッド' }[p.k]]++;
  function* jwwEntities() {
    const sen = { t: 'sen', glayer: 0, layer: 0, style: 1, color: 2, x1: 0, y1: 0, x2: 0, y2: 0 };
    for (let i = 0; i < lines.n; i++) {
      const li = Math.min(lines.layer[i], 255), o = i * 4;
      sen.glayer = li >> 4; sen.layer = li & 15; sen.style = lines.style[i]; sen.color = lines.color[i];
      sen.x1 = X(LX[o]); sen.y1 = Y(LX[o + 1]); sen.x2 = X(LX[o + 2]); sen.y2 = Y(LX[o + 3]);
      yield sen;
    }
    for (const p of prims) {
      const L = layerOf(p.layer);
      if (p.k === 'arc') yield { t: 'enko', ...L, style: p.style, color: p.color, cx: X(p.cx), cy: Y(p.cy), r: p.r * k, start: p.start, sweep: p.sweep, tilt: p.tilt, flat: p.flat, full: p.full };
      else if (p.k === 'point') yield { t: 'ten', ...L, color: p.color, x: X(p.x), y: Y(p.y) };
      else if (p.k === 'text') {
        const sy = Math.max(p.h * k, 0.05), sx = sy * p.wf, w = p.width * k;
        yield { t: 'moji', ...L, color: p.color, x1: X(p.x), y1: Y(p.y), x2: X(p.x) + Math.cos(p.ang) * w, y2: Y(p.y) + Math.sin(p.ang) * w, shu: 0, sx, sy, kankaku: 0, angle: ((p.ang * 180 / Math.PI) % 360 + 360) % 360, font: 'ＭＳ ゴシック', text: p.str };
      } else if (p.k === 'solid') {
        const rgb = p.rgb ? (p.rgb[0] | (p.rgb[1] << 8) | (p.rgb[2] << 16)) : null;
        yield { t: 'solid', ...L, color: p.color, rgb, p: p.p.map(([x, y]) => [X(x), Y(y)]) };
      }
    }
  }

  // ---- header
  const h = { ...DEFAULT_HEADER };
  h.memo = opts.memo || '';
  h.zumen = paper;
  h.writeGLay = 0;
  const nl = layerOrder.length;
  for (let g = 0; g < 16; g++) {
    h[`g${g}.state`] = g === 0 ? 3 : 2; h[`g${g}.writeLay`] = 0; h[`g${g}.scale`] = scale; h[`g${g}.protect`] = 0;
    h[`gLayName${g}`] = '';
    for (let l = 0; l < 16; l++) {
      const i = g * 16 + l; const name = i < nl ? layerOrder[i] : '';
      const info = name ? layerInfo(name) : null;
      const off = info && (info.color < 0 || (info.flags & 1));
      h[`g${g}.l${l}.state`] = g === 0 && l === 0 ? 3 : off ? 0 : 2;
      h[`g${g}.l${l}.protect`] = 0;
      h[`layName${g}.${l}`] = decodeEscapes(name).slice(0, 60);
    }
  }
  if (nl > 256) warn(`画層が${nl}個あり、Jw_cadの上限（256）を超えた分は最後のレイヤにまとめました`);
  const jww = writeJww(h, jwwEntities(), total);
  return { jww, info: { scale, paper, unit: ins, enc, ver, layers: nl, counts, skipped: stats.skipped, warnings: stats.warnings, byType: stats.byType, missingBlocks: [...stats.missingBlocks], sources, hatch: { lines: stats.hatchLines, dense: stats.hatchDense, outlined: stats.hatchOutlined, skipped: stats.hatchSkipped }, extentMM: [wmm, hmm], origin: [cx, cy], unitMM } };
}

// ---------------------------------------------------------------- curve simplification
// Douglas–Peucker: keep the fewest points whose polyline stays within tol of the dense sampling.
// tol defaults to 0.1% of the curve's bounding-box diagonal (e.g. 1 mm on a 1 m bend).
function simplify(pts, tol) {
  if (pts.length <= 3) return pts;
  if (tol === undefined) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    tol = Math.hypot(x1 - x0, y1 - y0) * 0.001;
    if (!(tol > 0)) return [pts[0], pts[pts.length - 1]];
  }
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d;
      if (L2 === 0) d = Math.hypot(px - ax, py - ay);
      else { const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)); d = Math.hypot(ax + dx * t - px, ay + dy * t - py); }
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > tol) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------- splines
function splinePoints(e) {
  const deg = gn(e, 71, 3);
  const knots = gall(e, 40).map(Number);
  const cx = gall(e, 10).map(Number), cy = gall(e, 20).map(Number);
  const w = gall(e, 41).map(Number);
  const ctrl = cx.map((x, i) => [x, cy[i]]);
  if (ctrl.length >= deg + 1 && knots.length === ctrl.length + deg + 1) {
    return deBoorSample(deg, knots, ctrl, w.length === ctrl.length ? w : null, Math.min(2000, Math.max(24, ctrl.length * 10)));
  }
  const fx = gall(e, 11).map(Number), fy = gall(e, 21).map(Number);
  if (fx.length >= 2) {
    const Q = fx.map((x, i) => [x, fy[i]]);
    const t0 = gv(e, 12) !== undefined ? [gn(e, 12), gn(e, 22)] : null, t1 = gv(e, 13) !== undefined ? [gn(e, 13), gn(e, 23)] : null;
    return interpolateFit(Q, t0, t1);
  }
  return ctrl;
}
// Cubic B-spline through fit points (chord-length parameters, end tangents given or estimated)
function interpolateFit(Q, t0, t1) {
  const n = Q.length - 1;
  if (n < 1) return Q;
  if (n === 1 || n > 400) return Q;
  const d = [0]; for (let i = 1; i <= n; i++) d.push(d[i - 1] + Math.hypot(Q[i][0] - Q[i - 1][0], Q[i][1] - Q[i - 1][1]));
  const L = d[n]; if (!(L > 0)) return Q;
  const u = d.map((v) => v / L);
  const unit = (v) => { const l = Math.hypot(v[0], v[1]); return l > 0 ? [v[0] / l, v[1] / l] : null; };
  let D0 = t0 && unit(t0), Dn = t1 && unit(t1);
  if (D0) D0 = [D0[0] * L, D0[1] * L];
  if (Dn) Dn = [Dn[0] * L, Dn[1] * L];
  const U = [0, 0, 0, 0, ...u.slice(1, n), 1, 1, 1, 1];
  const m = n + 3; // control points
  const basis = (i, uu) => { // Cox–de Boor, degree 3
    const N = []; for (let j = 0; j < U.length - 1; j++) N.push((uu >= U[j] && uu < U[j + 1]) || (uu === 1 && U[j] < 1 && U[j + 1] === 1) ? 1 : 0);
    for (let p = 1; p <= 3; p++) for (let j = 0; j < U.length - 1 - p; j++) {
      const a = U[j + p] - U[j] ? (uu - U[j]) / (U[j + p] - U[j]) * N[j] : 0;
      const b = U[j + p + 1] - U[j + 1] ? (U[j + p + 1] - uu) / (U[j + p + 1] - U[j + 1]) * N[j + 1] : 0;
      N[j] = a + b;
    }
    return N[i];
  };
  const A = [], B = [];
  const row = (coef, rhs) => { A.push(coef); B.push(rhs); };
  const e = (i) => { const r = new Array(m).fill(0); r[i] = 1; return r; };
  row(e(0), Q[0]);
  if (D0) { const r = new Array(m).fill(0); r[0] = -1; r[1] = 1; row(r, [D0[0] * U[4] / 3, D0[1] * U[4] / 3]); }
  else { const r = new Array(m).fill(0); const a1 = U[4], a2 = U[5]; r[0] = 1 / a1; r[1] = -(a1 + a2) / (a1 * a2); r[2] = 1 / a2; row(r, [0, 0]); } // natural end: C''(0) = 0
  for (let k = 1; k < n; k++) { const r = new Array(m).fill(0); for (let i = 0; i < m; i++) r[i] = basis(i, u[k]); row(r, Q[k]); }
  if (Dn) { const r = new Array(m).fill(0); r[m - 2] = -1; r[m - 1] = 1; row(r, [Dn[0] * (1 - U[m - 1]) / 3, Dn[1] * (1 - U[m - 1]) / 3]); }
  else { const r = new Array(m).fill(0); const b1 = 1 - U[m - 1], b2 = 1 - U[m - 2]; r[m - 1] = 1 / b1; r[m - 2] = -(b1 + b2) / (b1 * b2); r[m - 3] = 1 / b2; row(r, [0, 0]); } // C''(1) = 0
  row(e(m - 1), Q[n]);
  // Gaussian elimination
  const M = A.map((r, i) => [...r, B[i][0], B[i][1]]);
  for (let c = 0; c < m; c++) {
    let piv = c; for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return Q;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < m; r++) if (r !== c) { const f = M[r][c] / M[c][c]; if (f) for (let k = c; k < m + 2; k++) M[r][k] -= f * M[c][k]; }
  }
  const P = M.map((r, i) => [r[m] / r[i], r[m + 1] / r[i]]);
  return deBoorSample(3, U, P, null, Math.min(4000, Math.max(32, n * 32)));
}
function deBoorSample(p, U, P, W, n) {
  const out = []; const a = U[p], b = U[U.length - p - 1];
  if (!(b > a)) return P.slice();
  for (let s = 0; s <= n; s++) {
    let u = a + (b - a) * s / n; if (s === n) u = b - 1e-12 * (b - a);
    let k = p; while (k < U.length - p - 2 && u >= U[k + 1]) k++;
    const d = []; for (let j = 0; j <= p; j++) { const i = k - p + j; const wt = W ? W[i] : 1; d.push([P[i][0] * wt, P[i][1] * wt, wt]); }
    for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
      const i = k - p + j; const den = U[i + p - r + 1] - U[i]; const al = den === 0 ? 0 : (u - U[i]) / den;
      for (let c = 0; c < 3; c++) d[j][c] = (1 - al) * d[j - 1][c] + al * d[j][c];
    }
    out.push([d[p][0] / d[p][2], d[p][1] / d[p][2]]);
  }
  return out;
}
