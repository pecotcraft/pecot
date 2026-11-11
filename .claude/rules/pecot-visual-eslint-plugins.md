---
paths:
  - "plugins/pecot-visual/assets/slidev/scripts/eslint/**"
  - "plugins/pecot-visual/assets/slidev/deck-lint.config.js"
---

# pecot-visual 内製 ESLint plugin を編集する前に

pecot-visual 専用の ESLint plugin は、`plugins/pecot-visual/assets/slidev/scripts/eslint/` 配下にあります。
plugin は次の 6 つです。
`slidev-pages-lint` / `text-constraints` / `validate-references` / `2layer` / `asset-path` / `pptx-compat`

consumer は、これらを **dist 経由** で解決しています。
consumer は `assets/slidev/deck-lint.config.js` や `assets/slidev/eslint.config.js` などです。

## やってはいけない変更

- `deck-lint.config.js` / `eslint.config.js` で plugin を **source 直 import** に書き換える。
  例: `import plugin from "../scripts/eslint/slidev-pages-lint/lib/index.ts"`。
  consumer の lint runtime は ts を解釈できず、起動直後に失敗する

- `package.json` の `main` / `types` / `exports` を **`./lib/...` (source)** に向ける
  → 同上

- `_shared/package.json` 経由で再 export している型 (`FrontmatterBase` 等) の名前 / 形を変える。
  全 consumer plugin の型解決が連鎖して失敗する

## 編集後の確認手順

1. `pnpm -F @pecot/slidev-assets-dev build` で dist を再生成する。
   ビルド順は、各サブパッケージ tsconfig の `references` で `tsc -b` が解決する
2. `pnpm -F @pecot/slidev-assets-dev lint` が `--no-cache` で pass
3. dist 配下（`scripts/eslint/*/dist/`）は `.gitignore` で除外済みの **git 管理外**。
   commit には含まれない。利用者環境では bin/pecotv の bootstrap が再生成する

## 揺れた時の切り分け

結果が揺れる原因は 3 段階にあります。
`@v-slidev/eslint-shared` の dist 鮮度、incremental tsc cache、consumer の eslint cache です。
`pecot-visual-lint-determinism.md` の切り分け順序に従って、`--no-cache` と tsconfig の `references` を確認してください。
