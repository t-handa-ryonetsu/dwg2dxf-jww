#!/usr/bin/env node
// Command-line batch converter: DWG → DXF/JWW, DXF → JWW.
//   node scripts/cli.mjs [--jww] [--dxf] [--paper A3] [--scale 100] [--out DIR] FILE_OR_DIR...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!fs.existsSync(path.join(dist, 'dxf2jww.js'))) { console.error('dist/ がありません。先に npm run build を実行してください。'); process.exit(1); }
const { convertDxfToJww } = await import(path.join(dist, 'dxf2jww.js'));

const args = process.argv.slice(2);
const opt = { jww: false, dxf: false, paper: 3, scale: undefined, out: null, info: false, inputs: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--jww') opt.jww = true;
  else if (a === '--dxf') opt.dxf = true;
  else if (a === '--paper') opt.paper = ['A0', 'A1', 'A2', 'A3', 'A4'].indexOf(String(args[++i]).toUpperCase());
  else if (a === '--scale') opt.scale = Number(args[++i]) || undefined;
  else if (a === '--out') opt.out = args[++i];
  else if (a === '--info') opt.info = true;
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else opt.inputs.push(a);
}
if (!opt.jww && !opt.dxf) opt.jww = true;
if (opt.paper < 0) { console.error('--paper は A0〜A4 で指定してください'); process.exit(1); }
if (!opt.inputs.length) { usage(); process.exit(1); }
function usage() {
  console.log(`使い方: dwg2dxf-jww [--jww] [--dxf] [--paper A0..A4] [--scale 分母] [--out 出力フォルダ] ファイルまたはフォルダ...
  --jww     JWWを出力（既定）      --dxf    DWGからDXFを出力
  --paper   JWWの用紙（既定 A3）   --scale  JWWの縮尺の分母（省略時は自動）
  --out     出力先フォルダ（省略時は元ファイルの隣）
  --info    変換情報（縮尺・原点など）を .info.json に書き出す（検証用）`);
}

const files = [];
const walk = (p, rel) => {
  const st = fs.statSync(p);
  if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f), path.join(rel, f));
  else if (/\.(dwg|dxf)$/i.test(p)) files.push({ abs: p, rel });
};
for (const inp of opt.inputs) walk(inp, path.basename(inp));

let lib = null;
async function dwgToDxf(buf) {
  if (!lib) { const { default: createModule } = await import(path.join(dist, 'libredwg-web.js')); lib = await createModule({ print() {}, printErr() {} }); }
  lib.FS.writeFile('in.dwg', buf);
  const code = lib.dwg_write_dxf('in.dwg', 'out.dxf');
  const out = lib.FS.analyzePath('out.dxf', false).exists ? lib.FS.readFile('out.dxf') : null;
  try { lib.FS.unlink('in.dwg'); if (out) lib.FS.unlink('out.dxf'); } catch {}
  if (!out || !out.length || code >= 128) throw new Error('DWGを読み込めませんでした（エラーコード ' + code + '）');
  return out;
}

let failed = 0;
for (const f of files) {
  const base = opt.out ? path.join(opt.out, f.rel) : f.abs;
  try {
    const t0 = Date.now();
    const isDwg = /\.dwg$/i.test(f.abs);
    const input = new Uint8Array(fs.readFileSync(f.abs));
    const dxf = isDwg ? await dwgToDxf(input) : input;
    fs.mkdirSync(path.dirname(base), { recursive: true });
    const done = [];
    if (opt.dxf && isDwg) { fs.writeFileSync(base.replace(/\.dwg$/i, '.dxf'), dxf); done.push('DXF'); }
    if (opt.jww || !isDwg) {
      const { jww, info } = convertDxfToJww(dxf, { paper: opt.paper, scale: opt.scale });
      fs.writeFileSync(base.replace(/\.(dwg|dxf)$/i, '.jww'), jww);
      if (opt.info) fs.writeFileSync(base.replace(/\.(dwg|dxf)$/i, '.info.json'), JSON.stringify(info, null, 1));
      if (opt.info && isDwg && !opt.dxf) fs.writeFileSync(base.replace(/\.dwg$/i, '.dxf'), dxf);
      done.push(`JWW 1/${info.scale}`);
      for (const w of info.warnings) console.log('  注意:', w);
      const sk = Object.entries(info.skipped); if (sk.length) console.log('  変換しなかったもの:', sk.map(([k, v]) => `${k}×${v}`).join(', '));
    }
    console.log(`${f.rel} → ${done.join(' + ')} (${Date.now() - t0} ms)`);
  } catch (e) { failed++; console.error(`${f.rel}: 失敗 - ${e.message}`); }
}
console.log(`完了 ${files.length - failed} / 失敗 ${failed}`);
process.exit(failed ? 2 : 0);
