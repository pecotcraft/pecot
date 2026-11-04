---
paths:
  - "plugins/pecot-visual/assets/slidev/package.json"
  - "plugins/pecot-visual/assets/slidev/scripts/eslint/_shared/package.json"
---

# v-slidev / eslint-shared の package.json をいじる前に

これらの設定は **lint 結果の決定論化** のために意図的にこの形になっています。
何気なく変更すると同一ソースで lint 結果が揺れます。

## `plugins/pecot-visual/assets/slidev/package.json`

- `lint` script の `eslint --no-cache --max-warnings 0` から `--no-cache` を **消さない**
  - eslint cache が残っていると変更検知をスキップして古い結果を返す不具合が頻発したため
- ESLint plugin 群のビルド順は各サブパッケージ tsconfig の `references` で構造化済み。
  `_shared` を import する 3 サブパッケージ（`slidev-pages-lint` / `text-constraints`
  / `validate-references`）の tsconfig にある `references: [{ "path": "../_shared" }]`
  を **消さない**
  - references が `tsc -b` に依存グラフを伝え、`_shared` 変更時に dependents を正しく再ビルドさせる。
    これが無いと incremental tsc cache の dist 鮮度ズレで、`@v-slidev/eslint-shared` 経由の型解決が失敗する
  - references があるため `build` script は `tsc -b`（`--force` 無し）で incremental skip が機能する。
    `--force` を足し戻す必要は無い
- `engines.node`（`^24.22.1 || >=26.12.1`）を緩めない。
  下限は `plugins/pecot-visual/cli/src/node-runtime.ts` の表と一致させる。ESLint 10 / typescript-eslint 8 の前提でもある

## `scripts/eslint/_shared/package.json`

- `types`・`main`・`exports` は **`./dist/...`** に固定する。source の `index.ts` には向けない
  - source を直接参照すると ESLint plugin runtime と型解決が ts-node 経由になる。
    consumer 側の lint が「ts ファイルを読み込めない」エラーで失敗する
- `private: true` を外さない（このパッケージは publish 対象ではない）

## 揺れた時の切り分け順序

1. このルールに従っているか確認（`--no-cache` / tsconfig の `references` / `dist` 固定）
2. それでも揺れるなら build artifact のキャッシュ汚染を疑い `pnpm -r exec rm -rf dist node_modules/.cache` で再生成

元の記載: `CLAUDE.md` の「環境の既知事項」の pecot-visual の lint の項。
