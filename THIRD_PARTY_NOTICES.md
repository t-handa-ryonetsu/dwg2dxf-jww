# Third-party notices / 使用しているソフトウェア

This project is distributed under the GNU General Public License v3.0 or later (see `LICENSE`),
because the built site bundles GNU LibreDWG, which is licensed under GPLv3.

## GNU LibreDWG (via @mlightcad/libredwg-web)

- Used for: reading DWG files and writing DXF (compiled to WebAssembly)
- Package: [@mlightcad/libredwg-web](https://github.com/mlightcad/libredwg-web) 0.7.14
- Upstream: [GNU LibreDWG](https://www.gnu.org/software/libredwg/)
- License: GPL-3.0
- Files in the built site: `libredwg-web.js`, `libredwg-web.wasm` (copied from the npm package by `scripts/build.mjs`, unmodified).
  The corresponding source code is available from the repositories above.

## earcut

- Used for: triangulating solid-filled hatches (with holes) into Jw_cad solids
- Package: [earcut](https://github.com/mapbox/earcut) 3.2.4
- License: ISC — Copyright (c) Mapbox

```
ISC License

Copyright (c) 2026, Mapbox

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND ISC DISCLAIMS ALL WARRANTIES WITH REGARD TO
THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS.
IN NO EVENT SHALL ISC BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA
OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## References (not bundled)

- JWW data layout: "Jw_cadのデータ形式" published by the Jw_cad author (Jw_cad Ver.5.00a, data version 420),
  also included in LibreCAD's `libraries/jwwlib`.
- `src/jww-header.js` holds Jw_cad's default settings block (pen colours, line types, text styles).
  The values were read from a drawing saved by Jw_cad; the drawing's memo, layer names and content are not included.
- Real Jw_cad files used only in tests (not included in this repository), downloaded by CI from
  [ezjww](https://github.com/neka-nat/ezjww) (MIT).
