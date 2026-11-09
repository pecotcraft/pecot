# Contract: CLI の出力の行

pecot-workflow（Python と Node）・pecot-visual・pecot-tools の共通の関数が守る、行の形の決まり。行はすべて英語で書く。

## 行の種類

| 種類 | 形 | 出力先 | dry-run でのふるまい | 例 |
|---|---|---|---|---|
| error | `error: <message>` | stderr | 前置きは変えない | `error: no active project` |
| warning | `warning: <message>` | stderr | 前置きは変えない | `warning: PNG export failed: forced PDF failure` |
| note | `note: <message>` | stderr | 前置きは変えない | `note: plugin update available: 1.4.0` |
| plan | `dry-run: would <verb> <target>` | stderr | dry-run のときだけ出す | `dry-run: would update Tracker #179 body` |
| result | `<past>: <target>` | stderr | dry-run のときは出さない | `updated: Tracker #179 body` |
| count | `count: <label>: <value>` | stderr | 前置きは変えない | `count: PRs awaiting review: 3` |
| data | 中身をそのまま | stdout | 変えない | Issue の本文、表、JSON |

- plan と result は、同じ「操作」（動詞と対象）から作る。コマンドは操作を 1 つ作り、実行の前に plan を、実行の後に result を呼ぶ
- note は、pecot-visual と pecot-tools の情報の診断（今の `[info]`）だけに使う。pecot-workflow は進捗の行を出さない
- 前置きにプログラム名（`pecotv:`・`pecot-tools:`）を付けない

## 動詞

| 動詞（plan） | 過去分詞（result の前置き） |
|---|---|
| create | created |
| update | updated |
| delete | deleted |
| add | added |
| remove | removed |
| close | closed |
| merge | merged |
| move | moved |
| set | set |
| skip | skipped |
| （変化なし） | unchanged |

- 動詞は列挙型で持ち、自由な文字列を受け取らない。足すときは、この表と各 CLI の列挙型を同じ PR で直す
- `unchanged` は result だけに使う。plan の行は `dry-run: would leave <target> unchanged` とする

## 値の扱い

| 入力 | 出る語 |
|---|---|
| count の値が未設定（`None`・`null`・`undefined`） | `unknown` |
| count の値が 0 | `0` |
| message が複数行 | 2 行目以降の先頭に空白 2 つを付ける |
| message の末尾の改行 | 取り除いてから 1 つだけ付ける |

## 決まりの外に置くもの

| 対象 | 扱い |
|---|---|
| typer の `--help` と使い方エラーの枠 | typer の書式のまま。中の文言は英語にする |
| 終了コード | 変えない |
| GitHub に書く Issue・PR の本文とコメント | 変えない。日本語のまま |
| 埋め込む値（Issue のタイトルなど GitHub から読んだもの） | そのまま埋め込む |

## 期待の行の一覧

Python と Node の共通の関数が出す行の期待値は `plugins/pecot-workflow/cli-node/tests/output/cases.json` に置く。各要素は次の形。

```json
{
  "kind": "plan",
  "dryRun": true,
  "input": { "verb": "update", "target": "Tracker #179 body" },
  "stream": "stderr",
  "line": "dry-run: would update Tracker #179 body\n"
}
```

dry-run でない plan の要素は、`stream` を `null`、`line` を空文字列にする。
