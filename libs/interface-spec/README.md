# interface-spec

インタフェース定義書（`plugins/*/interface/`）の形式と検証。配布しない。

## 定義書の HTML

定義書の全項目を HTML に出します。`docs/` に sphinx-needs の project があります。公開サイトも、同じ target で作ります。

```bash
# 1. HTML を作る（libs/interface-spec/docs/_build）
pnpm exec nx run interface-spec:docs

# 2. 開く（http://localhost:8000/ のトップから入る）
python3 -m http.server -d libs/interface-spec/docs/_build
```

作る HTML の構成は次のとおり。

- トップ（`index.html`）: プラグインごとの一覧と、欄の対応表へのリンク
- プラグインの一覧表: ツールごとに、表示名・ツール名・説明・型を 1 行にする
  - 表示名は MCP の `title` で、ページへのリンクにする。型は MCP で、Actions から CLI でも呼ぶものは MCP・CLI
- ツールごとのページ: 題は表示名で、その下にツール名を添える。本文は定義書の本文（POSIX の節の順）を MCP のツールの形（引数名・`tools/call` の使用例・結果の項目）で書き、その項目の機能要件の表を続ける。`_generated/<plugin>/<名前>.html` にできる
  - CLI の節（構文・フラグ・標準入出力）と終了コードの列は、定義書に `cli_reference` を持つツールにだけ出す。今は GitHub Actions から CLI で呼ぶ pecot-workflow の 4 つ
- 共通の振る舞いのページ: 全コマンドに共通の振る舞い。`_generated/<plugin>/_common.html` にできる
- 欄の対応表（`field-map.html`）: 定義書の欄と POSIX の節の対応

`_generated/<plugin>/*.rst` は build のたびに定義書から書き直す。定義書から消えた項目のページは消える。

サイトに載せるのは、`plugins/<名前>/interface/generated.json` を持つプラグインです。プラグインを足すときは、`docs/reference/tools/<plugin>*.rst` も足します。

手元で作ったサイトは、どのページの上にも、ローカルでビルドしたことを伝える 1 行の知らせを出します。

### 見た目のテスト（`test-site`）

`test-site` のレーンは、サイトを一時ディレクトリにビルドし、Chromium で全ページを開いて次の崩れを測ります。

- 幅 1440px・1920px で、目次の無いページの本文の右に空欄が残る。目次の無いページの rst には、テーマの docs のとおり先頭に `:notoc: true` を付ける
- 見出しのリンクが、テーマのアイコンでなく文字の ¶ で出る。カーソルを当てる前から見える
- 幅 390px で、ページが横にはみ出す

```bash
pnpm exec nx run interface-spec:test-site
```

Chromium は pecot-visual と同じ版の playwright のものを使います。devcontainer は作るときに入れています。

ページを足すときは、次のとおりにします。

- 見出しが 1 段で目次の無いページには、rst の先頭に `:notoc: true` を付ける。付け忘れると、右の空欄の測りで落ちる
- 見出しが 2 段以上あり、右に目次が出るページには付けない
- `search.html` はテーマのテンプレートのページで、印を付けられない。右の空欄の測りからだけ外している（`tests/site/layout.test.ts` の `NO_NOTOC`）。¶ とはみ出しは測る

### 公開サイト

同じサイトを <https://pecotcraft.github.io/pecot/> で公開しています。公開の起動・やり直しと管理者の設定は `.claude/rules/pages-site.md` にあります。

開発版とリリース版では、機能要件の表の「テスト」の列から、その要件を確かめるテストをテストレポートで開けます。テストレポートの無い PR 版と手元のサイトには、この列を出しません。

## 名前の語彙（`names`）

`generated.json` の最上位の `names` に、項目の名前の決まりを書きます。各プラグインの書き出し（`cli/scripts/export-interface.ts`）が、ソースの語彙から作ります。`names` は必須です。

```json
{
  "separator": " ",
  "positions": [
    [{ "word": "issue", "meaning": "Issue そのもの" }],
    [{ "word": "show", "meaning": "1 件を出す", "read_only": true }, { "word": "create", "meaning": "GitHub のものを作る" }]
  ],
  "rest": false
}
```

| 欄 | 中身 |
|---|---|
| `separator` | 名前の語の区切り。`" "` か `"_"` |
| `positions` | 語の位置ごとの一覧。語（英小文字と数字）と意味を持つ |
| `read_only` | 読むだけの語の印。`true` だけを書く |
| `rest` | `true` なら、`positions` の後ろに 1 語以上の自由な語（英小文字と数字）を求める |

`validate`（`lint-defs`）は次を止めます。

- 項目の `name` を `separator` で分けた語の数が合わない。`rest` が `false` なら `positions` の数と同じ、`true` ならそれより多い数が要る
- 語が、その位置の一覧に無い
- 同じ位置に同じ語が 2 回ある
- 名前に `read_only` の語を持つ項目の `effects` に、`read` でない種類がある（`authored.yaml` の行で出す）

`read_only` の確かめが見るのは、`positions` に載った語だけです。
`rest` の側の語（pecot-tools の操作名など）には印を付けられないので、確かめの対象になりません。
今この確かめが働くのは、`read_only` の印を持つ pecot-workflow だけです。

書き出しの `--check` は `names` も比べるので、語彙を変えて書き出しを忘れると止まります。

| プラグイン | 区切り | 語彙の置き場 |
|---|---|---|
| pecot-workflow | 空白 | `cli/src/commands/names.ts` の `COMMAND_GROUPS`・`COMMAND_VERBS`（`readOnly` が印） |
| pecot-visual | `_` | `cli/src/mcp/tool-names.ts` の `TOOL_SUBJECTS`・`TOOL_VERBS` |
| pecot-tools | `_`（3 語目からは自由な語） | `cli/src/mcp/tool-names.ts` の `TOOL_PREFIXES`・`TOOL_SERVICES` |

### 語を足すとき

1. 上の表の語彙の置き場に、語と意味を足す。読むだけの動詞なら印を付ける
2. 書き出しを作り直す: `pnpm --dir plugins/<plugin>/cli exec tsx scripts/export-interface.ts --write`
3. `pnpm exec nx run interface-spec:lint-defs` で、名前と `effects` が語彙に合うかを確かめる

既にある語の意味を変えるときは、その語を使う全部の項目が新しい意味に合うかを確かめます。
