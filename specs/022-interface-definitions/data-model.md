# Data Model: インタフェース定義書

定義書は、プラグインごとの `interface/` に置く 2 つのファイルでできている。欄の形と、欄が従う枠組みの対応は [contracts/definition-format.md](contracts/definition-format.md) にある。

## 実体と関係

```text
定義書（プラグインごとに 1 つ）
├── generated.json   実装から書き出す
│   └── 項目 *       コマンドまたはツール 1 つ分
└── authored.yaml    人が書く
    ├── 環境変数 *    プラグインの全項目に共通のもの
    ├── 項目 *       generated.json の項目と ID で 1 対 1
    │   └── 振る舞いの項目 +   1 つ以上
    └── 共通の振る舞いの項目 *

テストのケース * ──verifies──> 振る舞いの項目 *
```

## 項目（書き出す側）

| 欄 | 型 | 決め |
|---|---|---|
| `id` | 文字列 | `PW-ISSUE-CREATE` の形。接頭辞と名前から機械的に作る。プラグインの中で重ならない |
| `name` | 文字列 | 人に見せる名前。CLI は `issue create`、MCP ツールは `aws_s3_ls` |
| `description` | 文字列 | 実装の説明と同じ文。英語 |
| `surfaces.cli.path` | 文字列の配列 | CLI のコマンドのパス。CLI で公開しない項目には無い |
| `surfaces.mcp.tool` | 文字列 | MCP ツールの名前。MCP で公開しない項目には無い |
| `hidden` | 真偽値 | 利用者の一覧に出さないコマンドなら真 |
| `deprecated` | 真偽値 | 実装が非推奨と宣言していれば真 |
| `input` | JSON Schema の object | 引数の名前・型・必須か・既定値・許可値・説明 |
| `cli.positional` | 文字列の配列 | `input` のうち、CLI で位置引数になるものの順 |
| `cli.flags` | 対応表 | `input` の名前から、CLI のオプションの名前（`--title`・`-t`）へ |
| `mcp.output` | JSON Schema の object | MCP ツールの `outputSchema`。CLI だけの項目には無い |
| `mcp.annotations` | 対応表 | MCP ツールの annotations（`readOnlyHint`・`destructiveHint`・`idempotentHint`・`openWorldHint`） |

`surfaces` は `cli` と `mcp` の少なくとも一方を持つ。Epic #42 の移行の後、pecot-workflow の項目は両方を持つ。

## 項目（人が書く側）

どの欄も省けない。使わない欄は、表の「使わないときの値」を書く。

| 欄 | 型 | 言語 | 使わないときの値 | 決め |
|---|---|---|---|---|
| `constraints` | 配列 | — | `[]` | 引数どうしの排他（`conflicts`）と依存（`requires`）。引数の名前は `input` にあるものだけ |
| `details` | 文字列の配列 | 英語 | 必ず書く | 外から観測できる結果を 1 文ずつ。内部の手順は書かない |
| `stdin` | 文字列 | 英語 | `none` | 標準入力から読むものと、その形 |
| `output` | 対象 | 英語 | `format: none` | CLI の標準出力の形。`format` は `text`・`json`・`none`。`json` なら `schema` に JSON Schema を書く。実装の出力と比べる確認は置かない |
| `diagnostics` | 文字列 | 英語 | `default` | 標準エラーに出すもの。`default` は、共通の関数の `error:`・`warning:` の行だけを指す |
| `environment` | 配列 | 英語 | `[]` | この項目だけが読む環境変数の名前と、変わる振る舞い。全項目に共通のものは、ファイルの先頭の `environment` に書く |
| `exit_status` | 配列 | 英語 | 必ず書く | CLI は終了コードと条件。MCP ツールは失敗の種別と条件 |
| `on_error` | 文字列 | 英語 | `default` | 失敗の後に残る状態。`default` は、何も作らず何も変えずに終わることを指す |
| `effects` | 配列 | 英語 | `[]` | 外部への副作用。相手は `github`・`aws`・`git`・`file`・`process`、種類は `read`・`write`・`destructive` |
| `prerequisites` | 文字列の配列 | 英語 | `[]` | 呼ぶ側が満たす事前条件（認証、設定ファイルなど） |
| `idempotent` | 真偽値 | — | 必ず書く | 同じ入力で 2 回呼んだ結果が、1 回と同じなら真 |
| `examples` | 配列 | 英語 | 必ず書く | 呼び出しの例と、その説明 |
| `default_notes` | 対応表 | 英語 | `{}` | 既定値が実行時に決まる引数の、決まり方 |
| `behaviors` | 配列 | 日本語 | 必ず書く | 振る舞いの項目。1 つ以上 |

## 振る舞いの項目

| 欄 | 型 | 決め |
|---|---|---|
| `id` | 文字列 | `<項目の id>-<2 桁の番号>`。例は `PW-ISSUE-CREATE-01`。一度付けた番号は付け替えない |
| `pattern` | 列挙 | EARS の型。`ubiquitous`・`event`・`state`・`unwanted`・`optional` |
| `statement` | 文字列 | 型に合った形の、日本語の 1 文。契機と応答を 1 組だけ書く |

共通の振る舞いの項目は、`<接頭辞>-COMMON-<2 桁の番号>` の ID を持ち、どの項目にも属さない。

## 検証の規則

| 規則 | 確かめる場所 |
|---|---|
| 2 つのファイルの項目の ID の集合が同じ | 形式の検証 |
| 人が書く文字列の欄が空でない（空白だけも空とみなす） | 形式の検証 |
| 人が書く側の欄がすべてある。知らない欄が無い | 形式の検証 |
| `constraints`・`default_notes` の引数の名前が `input` にある | 形式の検証 |
| 振る舞いの項目の ID が、プラグインをまたいで重ならない | 形式の検証 |
| `statement` に日本語の文字がある。ほかの人が書く欄に日本語の文字が無い | 形式の検証 |
| `statement` の形が `pattern` に合う | 形式の検証 |
| MCP ツールの `effects` の種類と `idempotent` が、`mcp.annotations` と食い違わない | 形式の検証 |
| ソースが読む環境変数の名前が、定義書の `environment` にある | 形式の検証（ソースの文字列を読む）。項目がそろったプラグインだけを対象にする |
| 形式の定義の欄が、すべて枠組みとの対応表にある | `libs/interface-spec` のテスト |
| `generated.json` が、実装から書き出し直したものと同じ | 各プラグインのテスト |
| 振る舞いの項目のすべてが、1 件以上のテストのファイルに書かれている | つなぎの確認 |
| テストに書かれた ID が、定義書にある | つなぎの確認 |

## 項目の一生

| 出来事 | `generated.json` | `authored.yaml` | CI |
|---|---|---|---|
| 実装にコマンドを足す | 書き出し直すと項目が増える | 項目を書くまで ID が足りない | 形式の検証が止める |
| 引数を足す・変える | 書き出し直すと `input` が変わる | `constraints` などが古い名前を指していれば直す | 一致の確認が止める。古い名前は形式の検証が止める |
| 新しい環境変数を読む | 変わらない | `environment` に足す | 形式の検証が止める |
| コマンドを消す | 書き出し直すと項目が消える | 項目と振る舞いの項目を消す | 形式の検証が止める。消した ID を書いたテストはつなぎの確認が止める |
| 振る舞いの項目を足す | 変わらない | `behaviors` に足す | テストに ID を書くまで、つなぎの確認が止める |
| Epic #42 でコマンドを Node に移す | 書き出しの元が Node になる。`surfaces.mcp` と `mcp.output` が増える | 変わらない | 一致の確認が、移行の前後の `input` の差を出す |
