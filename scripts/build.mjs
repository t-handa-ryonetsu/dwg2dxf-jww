// Assemble the static site in dist/: our sources plus the LibreDWG WebAssembly engine and earcut.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pkgDir = (name) => {
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  if (!fs.existsSync(dir)) throw new Error(`${name} がありません。先に npm install を実行してください。`);
  return dir;
};

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'src'))) fs.copyFileSync(path.join(root, 'src', f), path.join(dist, f));

const lib = pkgDir('@mlightcad/libredwg-web');
fs.copyFileSync(path.join(lib, 'wasm', 'libredwg-web.js'), path.join(dist, 'libredwg-web.js'));
fs.copyFileSync(path.join(lib, 'wasm', 'libredwg-web.wasm'), path.join(dist, 'libredwg-web.wasm'));
fs.copyFileSync(path.join(pkgDir('earcut'), 'src', 'earcut.js'), path.join(dist, 'earcut.js'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dist, 'LICENSE.txt'));
fs.copyFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(dist, 'THIRD_PARTY_NOTICES.md'));
fs.writeFileSync(path.join(dist, '.nojekyll'), '');
// Node treats dist/*.js as ES modules (the LibreDWG glue file is ESM)
fs.writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
console.log('built', path.relative(root, dist) + '/', fs.readdirSync(dist).join(' '));

// --docs: also refresh docs/ (the folder GitHub Pages publishes from: Settings → Pages → main /docs)
if (process.argv.includes('--docs')) {
  const docs = path.join(root, 'docs');
  fs.rmSync(docs, { recursive: true, force: true });
  fs.mkdirSync(docs);
  for (const f of fs.readdirSync(dist)) if (f !== 'package.json' && f !== 'THIRD_PARTY_NOTICES.md') fs.copyFileSync(path.join(dist, f), path.join(docs, f));
  console.log('updated docs/', fs.readdirSync(docs).join(' '));
}
