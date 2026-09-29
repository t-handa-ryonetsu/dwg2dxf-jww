# dwg2dxf-jww

**DWG・DXF・JWW 一括変換**

DWG・DXF の図面をまとめて DXF・JWW（Jw_cad）に変換するツールです。ブラウザだけで動き、図面ファイルは外部のサーバーに送られません。

*In-browser batch converter from DWG and DXF to DXF and JWW (Jw_cad). Nothing is uploaded; everything runs locally with WebAssembly.*

- **DWG → DXF**：GNU LibreDWG（WebAssembly 版）で変換します。R13〜2018 形式の DWG を読めます（AutoCAD 2018〜2025 で保存したファイルは 2018 形式）。
- **DWG / DXF → JWW**：JWW の書き出しは独自実装です。Jw_cad Ver.6 以降で開ける形式（データバージョン 600）で保存します。
- **一括処理**：ファイルやフォルダをドラッグ&ドロップすると、サブフォルダも含めて変換します。結果はフォルダ構成のまま ZIP にまとめ、変換レポートを付けます。
- **コマンドライン版**：Node.js から同じ変換エンジンでフォルダを一括変換できます。

## 使い方

### ブラウザ

GitHub Pages に公開したページ（`https://<ユーザー名>.github.io/dwg2dxf-jww/`）を開きます。

1. DWG・DXF ファイルかフォルダを枠にドロップする
2. 出力形式（JWW / DXF）、JWW の用紙・縮尺・ハッチング模様の扱いを選ぶ
3. 「変換を開始」を押し、終わったら「ZIPでダウンロード」を押す

### コマンドライン

```sh
npm install
npm run build
node scripts/cli.mjs --jww --dxf --paper A3 --out 変換結果 図面フォルダ/
# npm link すると dwg2dxf-jww コマンドとして使えます
```

| オプション | 内容 |
|---|---|
| `--jww` | JWW を出力（何も指定しないときの既定） |
| `--dxf` | DWG から DXF を出力 |
| `--paper A0〜A4` | JWW の用紙（既定 A3） |
| `--scale 100` | JWW の縮尺の分母（省略すると用紙に収まる縮尺を自動で選択） |
| `--units auto` | 図面の単位：`auto`（既定。mm・cm・m 以外は mm として扱う）／`mm`／`cm`／`m`／`inch` |
| `--hatch lines` | ハッチング模様：`lines` 線にする（既定）／`outline` 外形線だけ／`none` 入れない |
| `--out フォルダ` | 出力先（省略すると元ファイルの隣） |

## 変換の内容（DXF → JWW）

| DXF | JWW |
|---|---|
| LINE, LWPOLYLINE, POLYLINE（2D/3D/ポリフェースメッシュ）, LEADER | 線（ふくらみ付きの区間は円弧） |
| CIRCLE, ARC, ELLIPSE | 円・円弧・楕円（扁平率・傾き角） |
| SPLINE | 線（制御点から de Boor 法で計算。フィット点だけの場合は AutoCAD と同じ方式の3次補間。曲線の大きさの 0.1% 以内の誤差で必要な本数に間引く） |
| TEXT, MTEXT, ATTRIB, MULTILEADER の文字 | 文字（ＭＳ ゴシック、揃え位置を反映、書式コードは除去） |
| SOLID, TRACE | ソリッド |
| HATCH（塗りつぶし） | ソリッド（穴のある領域も三角形に分割） |
| HATCH（模様） | 線（パターン定義から線を生成。1つで5万本を超える細かい模様は外形線） |
| INSERT, DIMENSION, ACAD_TABLE | 分解して線・円弧・文字（回転・ミラー・不均等な尺度・配列にも対応）。図形データが無い長さ寸法・平行寸法は位置と値から描き直す |
| POINT | 点 |

- **画層**：使われている順に「レイヤグループ 0〜F × レイヤ 0〜F」へ割り当て、画層名をレイヤ名にします。非表示・フリーズの画層は非表示レイヤになります（256 画層を超えた分は最後のレイヤにまとめます）。
- **色**：ACI・トゥルーカラーを近い線色 1〜9 に置き換えます。ソリッドは元の RGB 色で塗ります。
- **線種**：名前から推定します（CONTINUOUS → 実線、HIDDEN/DASHED → 点線、CENTER/DASHDOT → 一点鎖、PHANTOM/DIVIDE → 二点鎖）。
- **単位**：`$INSUNITS` が mm・cm・m ならその単位で読みます。インチ・フィートなどになっている場合は、AutoCAD の既定テンプレートのまま作られた mm の図面であることが多いため mm として扱い、警告を出します（設定で変更できます）。
- **縮尺と用紙**：「自動」の場合は、図面が用紙の 9 割に収まる一般的な縮尺を選び、図面の中心を用紙の中心に置きます。大きく離れた位置にある図形は縮尺の計算から除き、警告を出します。
- **文字コード**：AutoCAD 2007 以降は UTF-8、それ以前は `$DWGCODEPAGE`（ANSI_932 なら Shift_JIS）で読みます。`\U+XXXX` と `\M+nXXXX` の表記にも対応しています。
- **図形の数**：1ファイル 800 万個まで変換します（線はメモリ効率のよい形で保持）。超えた場合は警告を出して残りを省きます。ハッチング模様を「外形線だけ」「入れない」にすると大きく減らせます。
- **変換しないもの**：REGION、3DSOLID、BODY、WIPEOUT、IMAGE、MLINE、TOLERANCE、XLINE、RAY、ペーパー空間の図形。変換しなかった種類と個数は画面と変換レポートに出ます。

## 開発

```sh
npm install      # LibreDWG（WebAssembly）と earcut を取得
npm start        # dist/ を作って http://localhost:8080/ で起動
npm test         # 単体テスト
```

```
src/
  index.html      画面（ファイル選択・設定・一覧・ZIP 作成）
  worker.js       Web Worker：DWG→DXF（LibreDWG）と DXF→JWW を実行
  dxf2jww.js      DXF の読み込みと JWW 図形への変換
  jww.js          JWW の読み書き（MFC CArchive 形式、Shift_JIS）
  jww-header.js   Jw_cad の既定の設定値（線色・線種・文字種など）
scripts/
  build.mjs       src/ と依存パッケージから dist/ を作る（--docs で docs/ も更新）
  cli.mjs         コマンドライン版
  serve.mjs       開発用サーバー
test/             node:test のテストとテスト用 DXF
tools/            テスト用 DXF の生成、ezdxf・ezjww による形状の検証
docs/             GitHub Pages で公開するサイト（npm run docs で作成）
```

### 検証の方法

- **JWW 形式**：Jw_cad で保存された実際の JWW ファイルを読み込んで書き出し直し、元のファイルと 1 バイト単位で一致することを確認しています（`test/samples.test.mjs`、サンプルは [ezjww](https://github.com/neka-nat/ezjww) のもの）。
- **形状**：変換した JWW を別のライブラリ（ezjww）で読み、元の DXF を ezdxf で分解したものと比べます。すべての線・円弧が図面の大きさの 0.02% 以内に入ることを確認します（`tools/verify_geometry.py`）。

```sh
pip install -r tools/requirements.txt
node scripts/cli.mjs --info --out out test/fixtures
python tools/verify_geometry.py out
```

GitHub Actions で push のたびに両方を実行します（`.github/workflows/ci.yml`）。

### JWW 形式についてのメモ

- 形式は Jw_cad の作者が公開している「Jw_cad のデータ形式」に基づきます。ファイル全体は MFC の `CArchive` でシリアライズされています。
- 先頭は `JwwData.` とバージョン番号（DWORD）。このツールは 600 で書き出します。各クラスの最初のオブジェクトの前に `0xFFFF`、スキーマ番号（= バージョン、600）、クラス名が入ります。2 個目以降は `0x8000 | クラス番号` で参照します。番号はクラスとオブジェクトで共通の連番です。
- 文字列は MFC の `CString`（長さ BYTE、255 以上は `0xFF` + WORD）で、Shift_JIS（CP932）です。
- 座標と文字の大きさは**用紙上の mm（図寸）**で、実寸はこれにレイヤグループの縮尺を掛けた値です。用紙の中心が原点です。
- 図形リストの後に、ブロック定義リストの個数（WORD）が続きます。このツールはブロックを分解するので 0 を書きます。

## GitHub Pages で公開する

公開用のサイトは `docs/` フォルダに入っています（`npm run build` で作ったものと同じ内容です）。

1. **Settings → Pages → Build and deployment** で **Source** を **Deploy from a branch** にする
2. **Branch** を `main`、フォルダを `/docs` にして **Save** する
3. 1〜2分で `https://<ユーザー名>.github.io/dwg2dxf-jww/` に公開されます

プログラムを直したときは `npm run docs` で `docs/` を作り直し、コミットしてください。

## ライセンス

[GNU General Public License v3.0 or later](LICENSE)

公開するページには GNU LibreDWG（GPLv3）を組み込むため、このプロジェクトも GPLv3 以降で配布します。使用しているソフトウェアは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にまとめています。

Jw_cad は清水治郎・田中善文両氏のソフトウェアです。このプロジェクトは Jw_cad の作者とは関係ありません。AutoCAD・DWG は Autodesk, Inc. の商標です。
