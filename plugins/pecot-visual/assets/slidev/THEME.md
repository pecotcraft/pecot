# テーマの pecot 用の宣言

テーマの作り手は、この文書だけを見て宣言を書ける。

## テーマのパッケージの形

```text
<theme-root>/
├── package.json          # name、peerDependencies（vue・@slidev/*）、dependencies（テーマだけが使う依存）
├── pecot-theme.json       # pecot 用の宣言（下記）
├── references/           # レイアウトごとの宣言（今の pages/_references/*.yaml と同じ形）
│   ├── _common.yaml
│   └── <layout>.yaml
├── layouts/  components/  composables/  setup/  styles/  utils/
├── patches/              # テーマの依存に当てる patch（任意）
└── public/               # /theme/... で配信される
```

- `package.json` に `prepare`・`build`・`prepack`・`install`・`postinstall` を置かない。取得時に何も動かさない
- `vue` と `@slidev/*` は `peerDependencies` に書く。テーマの置き場には入れず、本体の依存を使う
- peer の版は、本体の実行時依存の manifest（`assets/slidev/runtime/package.json`）の直接依存の版に合わせる。本体の依存を更新したら、テーマの peer も合わせて更新する
- `public/` の素材は `/theme/<path>` で参照する。`import.meta.env.BASE_URL` を前に付ける

## `pecot-theme.json`

```json
{
  "schema": 1,
  "slide": { "width": 960, "height": 540 },
  "fonts": {
    "body": ["Inter", "Noto Sans JP"],
    "heading": ["..."],
    "eastAsian": "Noto Sans JP"
  },
  "fontSizes": { "heading": 16, "headingSm": 13, "body": 12, "bodySm": 10, "label": 9 },
  "pptx": { "eastAsianFont": "Noto Sans JP", "linkColor": "4F46E5" },
  "lint": {
    "rules": { "slidev-pages-lint/no-unknown-props": "error", "text-constraints/max-chars": "error" }
  },
  "layouts": { "references": "references" },
  "drawio": {
    "panels": { "topic-intro": { "width": 400, "height": 300 } },
    "markerLayouts": ["annotated-diagram"]
  }
}
```

| 項目 | 必須 | 使う側 | 内容 |
|---|---|---|---|
| `schema` | 必須 | 全部 | 宣言の形の版。今は `1`。知らない版なら警告し、本体の既定値で続ける |
| `slide` | 任意 | スキル | 版面の幅と高さ（px）。`slide_theme` の `declaration` に載るだけで、PPTX 変換・lint・図は読まない |
| `fonts.body` | 任意 | v-drawio、スキル | 書体の並び。先頭を主に使う |
| `fonts.heading` | 任意 | スキル | 見出しの書体の並び。`slide_theme` の `declaration` に載るだけで、v-drawio・PPTX 変換は読まない |
| `fonts.eastAsian` | 任意 | v-drawio | 日本語の書体 |
| `fontSizes` | 任意 | v-drawio | 図の文字サイズの 5 段（px） |
| `pptx.eastAsianFont` / `pptx.linkColor` | 任意 | PPTX 変換 | PPTX に書く東アジア書体とリンク色（6 桁の 16 進）。省いた項目は PPTX に書かない（下記） |
| `lint.rules` | 任意 | deck lint | 有効にする規則と重さ。本体の `deck-lint.config.js` にある規則だけを書ける。知らない規則名は lint の設定の誤りとして止める |
| `layouts.references` | 任意 | lint、レイアウトの一覧、`slide_page` | レイアウトの宣言のディレクトリ。既定は `references` |
| `drawio.panels` | 任意 | no-scaled-drawio、drawio-model | 図の枠を持つレイアウトと、その枠の寸法 |
| `drawio.markerLayouts` | 任意 | no-missing-marker-cell | 図に印のセルを求めるレイアウト |

省いた項目には本体の既定値を使う。ただし `pptx.*` には既定値が無い。省いた分は PPTX に書かない。

- `pptx.eastAsianFont` を省くと、PPTX に東アジア書体を書き込まない
- `pptx.linkColor` を省くと、PPTX でリンクをハイパーリンクに変換しない
- どちらも、省いたことを警告で知らせる

## `references/<layout>.yaml`

今の `pages/_references/<layout>.yaml` と同じ形。最上位のキーは次のとおり。

- `layout`・`description`・`category`・`includes`・`status`
- `props`（`type`・`required`・`items`・`same_length_as`）
- `text_constraints`（`min_chars`・`max_chars`・`min_items`・`max_items`・`bold_required`・`note`）
- `clicks.validation`・`examples`・`best_practices`・`anti_patterns`

分類の語彙は `_common.yaml` の `layout_categories` に置く。

## talk-dir のローカルの宣言

talk-dir の `layouts/<name>.vue` がテーマの同名レイアウトを上書きするときは、talk-dir の `references/<name>.yaml` を置ける。lint・レイアウトの一覧・`slide_page` は、テーマより talk-dir の側を使う。

## 宣言の読み方

1. talk-dir の `package.json` の `dependencies` から、`theme:` の名前に当たるパッケージを探す
2. `node_modules/<name>/pecot-theme.json` を読む。無ければ警告し、既定値を使う
3. `layouts.references` のディレクトリの yaml を読み、talk-dir の `references/` で上書きする

読み取りは CLI の domain 層の 1 か所にまとめる。CLI・MCP・hooks・lint の規則は、この結果を受け取る。
