# interface-spec

インタフェース定義書（`plugins/*/interface/`）の形式と検証。配布しない。

## 定義書と合否の HTML

定義書の全項目と、振る舞いの項目ごとのテストと合否を HTML に出します。`docs/` に sphinx-needs の project があります。

```bash
# 1. JUnit を出す
pnpm exec nx run-many -t test-cli test-hooks --projects=pecot-workflow,pecot-tools,pecot-visual

# 2. HTML を作る（libs/interface-spec/docs/_build）
pnpm exec nx run interface-spec:docs

# 3. 開く（http://localhost:8000/ のトップから入る）
python3 -m http.server -d libs/interface-spec/docs/_build
```

作る HTML の構成は次のとおり。

- トップ（`index.html`）: プラグインごとの一覧と、欄の対応表へのリンク
- プラグインの一覧表: コマンド・ツールごとに、名前（ページへのリンク）・surface・説明・振る舞いの合否の数（「2 passed, 1 not run」の形）を 1 行にする。最後の行は共通の振る舞い。表の下に、そのプラグインのテストの表を置く
- コマンド・ツールごとのページ: 定義書の本文（POSIX の節の順）と、その項目の振る舞いごとの合否・つながるテストケース。`_generated/<plugin>/<名前>.html` にできる
- 共通の振る舞いのページ: 全コマンドに共通の振る舞い。`_generated/<plugin>/_common.html` にできる
- 欄の対応表（`field-map.html`）: 定義書の欄と POSIX の節の対応

`_generated/<plugin>/*.rst` は build のたびに定義書から書き直す。定義書から消えた項目のページは消える。

- JUnit が無くても作れる。合否は「未実行」になる
- 読む JUnit は `docs/conf.py` の `iface_junit` に並べている
- 項目の ID を書いたテスト（`verifies`）だけが、項目につながる。定義書に無い ID のケースは落とす

### CI の artifact に上げない理由

CI は affected のレーンだけを matrix の job に分けて動かすので、1 つの job に全レーンの JUnit がそろいません。
そろわない JUnit で作った HTML は、動かなかったレーンの項目を「未実行」と出し、読む人を誤らせます。
全量を集める job を足す案は、全レーンを毎回動かすことになるので採りません。

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
