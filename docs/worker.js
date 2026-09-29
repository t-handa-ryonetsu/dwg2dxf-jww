import createModule from './libredwg-web.js';
import { convertDxfToJww } from './dxf2jww.js';

let modP = null;
function getMod() {
  if (!modP) modP = createModule({ print: () => {}, printErr: () => {} });
  return modP;
}
// Count entities in the DXF ENTITIES section (group code 0 lines between SECTION/ENTITIES and ENDSEC)
function countEntities(u8) {
  const txt = new TextDecoder('latin1').decode(u8);
  const s = txt.search(/\n\s*2\r?\nENTITIES\r?\n/);
  if (s < 0) return 0;
  const e = txt.indexOf('ENDSEC', s);
  const seg = txt.slice(s, e < 0 ? undefined : e);
  const m = seg.match(/\n\s*0\r?\n[A-Z_]/g);
  return m ? m.length : 0;
}
function dwgToDxf(m, buf) {
  m.FS.writeFile('in.dwg', new Uint8Array(buf));
  try {
    const code = m.dwg_write_dxf('in.dwg', 'out.dxf');
    let out = null;
    if (m.FS.analyzePath('out.dxf', false).exists) out = m.FS.readFile('out.dxf');
    if (!out || out.length === 0) return { err: 'DXFを書き出せませんでした（エラーコード ' + code + '）' };
    if (code >= 128) return { err: '図面を読み込めませんでした（エラーコード ' + code + '）' };
    if (countEntities(out) === 0) return { err: '図形が1つも読み取れませんでした。ファイルが壊れているか、未対応の形式です' };
    return { dxf: out.slice(), code };
  } finally {
    try { if (m.FS.analyzePath('in.dwg', false).exists) m.FS.unlink('in.dwg'); if (m.FS.analyzePath('out.dxf', false).exists) m.FS.unlink('out.dxf'); } catch {}
  }
}

self.onmessage = async (ev) => {
  const { id, buf, kind, want, opts } = ev.data;
  if (id === 'init') {
    try { await getMod(); self.postMessage({ id, ok: true }); }
    catch (e) { self.postMessage({ id, ok: false, err: String(e && e.message || e) }); }
    return;
  }
  const t0 = performance.now();
  try {
    let dxf = null, code = 0;
    if (kind === 'dwg') {
      const m = await getMod();
      const r = dwgToDxf(m, buf);
      if (r.err) { self.postMessage({ id, ok: false, err: r.err }); return; }
      dxf = r.dxf; code = r.code;
    } else {
      dxf = new Uint8Array(buf);
    }
    const res = { id, ok: true, code, transfer: [] };
    if (want.jww) {
      try {
        const { jww, info } = convertDxfToJww(dxf, opts);
        res.jww = jww.buffer; res.info = info; res.transfer.push(jww.buffer);
      } catch (e) {
        res.jwwErr = 'JWWに変換できませんでした（' + (e && e.message || e) + '）';
      }
    }
    if (want.dxf && kind === 'dwg') { res.dxf = dxf.buffer; res.transfer.push(dxf.buffer); }
    res.ms = performance.now() - t0;
    const tr = res.transfer; delete res.transfer;
    self.postMessage(res, tr);
  } catch (e) {
    self.postMessage({ id, ok: false, fatal: true, err: String(e && e.message || e) });
  }
};
