# Contract: 定義書の形式

プラグインごとに `plugins/<plugin>/interface/` を置く。形式の正は `libs/interface-spec` の zod の定義で、この文書はその読み方を示す。

## 欄が従う枠組み

1 コマンド・1 ツールに書く欄は、POSIX（IEEE Std 1003.1-2024）のユーティリティ記述の節立てに対応づける。POSIX に節の無い欄は、借りた先を書く。

実装の後は、この対応の正を `libs/interface-spec/src/domain/field-map.ts` に置く。形式の定義の欄がすべて表にあることを、テストが確かめる。表示の HTML にも同じ表を出す。

| POSIX の節 | 定義書の欄 | 書き手 | MCP ツールでの読み替え |
|---|---|---|---|
| NAME | `id`・`name`・`description` | 書き出し | Tool の `name`・`description` |
| SYNOPSIS | `surfaces.cli.path`・`cli.positional`・`cli.flags`・`constraints` | 書き出し。`constraints` は人 | `surfaces.mcp.tool` |
| DESCRIPTION | `details` | 人 | 同じ |
| OPTIONS・OPERANDS | `input`・`default_notes` | 書き出し。`default_notes` は人 | Tool の `inputSchema` |
| STDIN | `stdin` | 人 | 常に `none` |
| INPUT FILES・OUTPUT FILES | `effects` のうち相手が `file` のもの | 人 | 同じ |
| ENVIRONMENT VARIABLES | `environment` | 人。ソースの文字列と比べる | 同じ |
| ASYNCHRONOUS EVENTS | 欄にしない。全項目が既定の扱い | — | — |
| STDOUT | `output`・`mcp.output` | CLI は人。MCP ツールは書き出し（`mcp.output`） | Tool の `outputSchema` と結果の構造 |
| STDERR | `diagnostics` | 人 | 失敗の結果に入る文言 |
| EXIT STATUS | `exit_status` | 人 | 失敗の種別（`isError` が真になる条件） |
| CONSEQUENCES OF ERRORS | `on_error` | 人 | 同じ |
| EXAMPLES | `examples` | 人 | 同じ |
| FUTURE DIRECTIONS | `deprecated` | 書き出し | 同じ |
| CHANGE HISTORY | 欄にしない。各プラグインの CHANGELOG が担う | — | — |

| POSIX に節の無い欄 | 借りた先 |
|---|---|
| `effects`（相手が `github`・`aws`・`git`・`process` のもの）・`idempotent`・`mcp.annotations` | MCP の Tool の annotations（`readOnlyHint`・`destructiveHint`・`idempotentHint`・`openWorldHint`） |
| `prerequisites` | 設計契約の事前条件。呼ぶ側が満たす |
| `behaviors` | 要件の書き方（EARS）と、要件とテストの双方向の追跡 |
| `hidden` | このリポの決め。利用者の一覧に出さない項目を表す |

書くものと書かないものは、Diátaxis のリファレンスの決めに従う。定義書には記述だけを書く。使い方の手順・設計の理由・議論は書かない。

MCP ツールへの読み替えは、このリポの決めだ。POSIX の規格に裏付けは無い。

## `generated.json`

書き出しのコマンドだけが書く。手で直さない。項目は `id` の順に並べ、キーの順も固定する。同じ実装からは、いつも同じバイト列が出る。

```json
{
  "format": 1,
  "plugin": "pecot-workflow",
  "prefix": "PW",
  "entries": [
    {
      "id": "PW-ISSUE-CREATE",
      "name": "issue create",
      "description": "Create an issue from a Markdown file with front matter.",
      "surfaces": { "cli": { "path": ["issue", "create"] } },
      "hidden": false,
      "deprecated": false,
      "input": {
        "type": "object",
        "properties": {
          "files": { "type": "array", "items": { "type": "string" }, "description": "Markdown files to post." },
          "issue_type": { "type": "string", "enum": ["task", "bug", "epic", "tracker"], "default": "task", "description": "Issue type." }
        },
        "required": [],
        "additionalProperties": false
      },
      "cli": {
        "positional": ["files"],
        "flags": { "issue_type": ["--type"] }
      }
    }
  ]
}
```

| 決め | 内容 |
|---|---|
| `id` | `<prefix>-<名前を大文字にし、空白と`_` を `-`にしたもの>`。接頭辞は pecot-workflow が `PW`、pecot-tools が `PT`、pecot-visual が `PV` |
| `input` の名前 | CLI は、オプション名の `-` を `_` にしたもの。`cli-node/` の `CommandSpec` と同じ決めにする |
| `input` の型 | JSON Schema 2020-12。MCP ツールは `tools/list` の `inputSchema` をそのまま入れる |
| 既定値 | 固定の値だけを `default` に入れる。実行時に決まるものは入れず、`authored.yaml` の `default_notes` に書く |
| `surfaces` | CLI のコマンドは `cli.path`、MCP ツールは `mcp.tool`。両方で公開する操作は、1 つの項目が両方を持つ |
| MCP ツールの出力と注釈 | `tools/list` の `outputSchema` を `mcp.output` に、`annotations` を `mcp.annotations` に入れる |

## `authored.yaml`

人とエージェントが書く。書き出しのコマンドは、このファイルを読まず、書かない。

```yaml
format: 1
plugin: pecot-workflow
environment:
  - name: PECOT_GITHUB_API_URL
    effect: Sends GitHub API requests to this URL instead of api.github.com.
entries:
  PW-ISSUE-CREATE:
    constraints:
      - conflicts: [message, files]
      - requires: { message: [title] }
    details:
      - Creates one issue per file and adds each to the project board.
      - Prints the URL of each created issue.
    stdin: none
    output:
      format: text
      description: One line per created issue, with its URL.
    diagnostics: default
    environment: []
    exit_status:
      - code: 0
        when: Every issue was created.
      - code: 1
        when: The front matter is invalid, or the GitHub API returned an error.
    on_error: Issues created before the failing file remain on GitHub.
    effects:
      - target: github
        kind: write
        what: Creates an issue and adds it to the project board.
      - target: file
        kind: read
        what: Reads the Markdown files given as arguments.
    prerequisites:
      - gh is authenticated for the target repository.
    idempotent: false
    examples:
      - run: pecot issue create .pecot/work/199/issue.md
        note: Create one issue from a file.
    default_notes:
      repo: Resolved from the git remote of the current directory.
    behaviors:
      - id: PW-ISSUE-CREATE-01
        pattern: unwanted
        statement: もしフロントマターに type が無いなら、Issue を作らずに終了コード 1 で終わる
      - id: PW-ISSUE-CREATE-02
        pattern: event
        statement: 複数のファイルを渡すと、渡した順に 1 件ずつ Issue を作る
common_behaviors:
  - id: PW-COMMON-01
    pattern: unwanted
    statement: もし知らないオプションを渡したなら、使い方のエラーを出して終了コード 2 で終わる
```

欄ごとの型・言語・使わないときの値は [data-model.md](../data-model.md) にある。どの欄も省けない。

## 振る舞いの項目の文の型

文は EARS の 5 つの型のどれかで書く。主語（コマンド・ツールの名前）は書かず、項目の ID で補う。日本語の形は、このリポの規約だ。

| `pattern` | EARS の型 | 日本語の形 | 例 |
|---|---|---|---|
| `ubiquitous` | Ubiquitous | 「常に、〜する」 | 常に、結果の行を標準エラーに出す |
| `event` | Event-driven（When） | 「〜すると、〜する」 | `--dry-run` を付けて呼ぶと、GitHub に書かずに予定の行を出す |
| `state` | State-driven（While） | 「〜の間、〜する」 | 作業中の Issue がある間、別の Issue のブランチを作らない |
| `unwanted` | Unwanted behaviour（If / then） | 「もし〜なら、〜する」 | もし認証が切れているなら、失敗の種別 auth-expired を返す |
| `optional` | Optional feature（Where） | 「〜が有効なら、〜する」 | ロードマップリポの設定が有効なら、Epic をそのリポに作る |

| 決め | 内容 |
|---|---|
| 1 文 1 要件 | 契機と応答を 1 組だけ書く。応答が 2 つあるときは、項目を分ける |
| 観測できる応答 | 応答は、出力・終了の状態・副作用のどれかで確かめられる形で書く。「正しく処理する」のような語を使わない |
| 型と形の一致 | 形式の検証が、`pattern` と文の形（「〜と、」「〜の間、」「もし〜なら、」など）を比べる |

上の例の `PW-ISSUE-CREATE-01` は、応答が「作らない」と「終了コード 1」の 2 つある。実物を書くときは、確かめたい応答ごとに項目を分ける。

## 形式の検証が出す失敗

失敗は 1 件 1 行で、ファイル・項目の ID・欄・理由を出す。

```text
error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-QUICK: entry is missing (present in generated.json)
error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE: on_error: field is missing (write "default" if nothing remains)
error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE: constraints[0].conflicts: unknown input name "mesage"
error: plugins/pecot-tools/interface/authored.yaml: PT-AWS-S3-LS-01: statement does not match pattern "unwanted"
error: plugins/pecot-tools/interface/authored.yaml: PT-AWS-S3-CP: effects has kind "write" but annotations.readOnlyHint is true
error: plugins/pecot-workflow/interface/authored.yaml: environment: PECOT_SESSION_PROJECT_DIR is read by cli/core/session.py but not listed
```

形の誤りと意味の誤りは、同じ実行でそろえて出す。欄が足りない項目でも、その項目の振る舞いの項目は確認する。

実装が出す行は、次の形だ。`<file>` はリポジトリのルートからのパス。

| 場合 | 行 |
|---|---|
| 知らない欄 | `error: <file>: PW-ISSUE-CREATE: owner: unknown field` |
| 欄が無い | `error: <file>: PW-ISSUE-CREATE: on_error: field is missing (write "default" if nothing remains)`。「使わないときの値」がある欄だけ括弧を付ける |
| 型が違う（YAML の `null` を含む） | `error: <file>: PW-ISSUE-CREATE: on_error: expected string but got null` |
| 列挙の値が違う | `error: <file>: PW-ISSUE-CREATE: output.format: unknown value "bogus" (expected one of "text", "json", "none")` |
| 知らない `format` | `error: <file>: format: unknown value 2 (expected 1)` |
| 英語の欄に日本語 | `error: <file>: PW-ISSUE-CREATE: details[1]: contains Japanese text (write English)` |
| `statement` に日本語が無い | `error: <file>: PW-ISSUE-CREATE-01: statement: has no Japanese text (write Japanese)` |
| 振る舞いの項目の ID の形 | `error: <file>: PW-ISSUE-QUICK: behaviors[0].id: "PW-ISSUE-QUICK-1" must be "PW-ISSUE-QUICK-NN" (NN is 2 digits)`。共通の項目は `PT-COMMON-NN` |
| ID が重なる（同じファイル） | `error: <file>: PW-ISSUE-CREATE-01: id: is defined more than once` |
| ID が重なる（別のプラグイン） | `error: <file>: PW-COMMON-01: id: is also defined in <先に定義したファイル>` |
| `generated.json` に無い項目 | `error: <file>: PW-ISSUE-OLD: entry is not in generated.json (remove it)` |
| ファイルが無い | `error: <file>: file is missing` |
| `interface/` が無い | `error: plugins/<plugin>/interface: directory is missing (listed in libs/interface-spec/targets.json)` |
| YAML の構文 | `error: <file>:17: map keys must be unique`。JSON の構文も、位置が分かるときは `error: <file>:3: is not valid JSON`（位置が無いときは行番号なし）。alias の展開で読めない YAML は行番号なしで止める |
| 終了コードが範囲外 | `error: <file>: PW-ISSUE-CREATE: exit_status[1].code: must be between 0 and 255` |
| 読み方が決まっていない zod の指摘 | `error: <file>: PW-ISSUE-CREATE: x: unknown validation issue (not_multiple_of): Invalid number: must be a multiple of 5` |

並べ方は、ファイル・行・項目の ID・欄・理由の順で、同じ入力からはいつも同じ順になる。

### 環境変数の確認の決め

| 決め | 内容 |
|---|---|
| 読みに数えるもの | Python は `os.environ[...]`・`os.environ.get(...)`・`os.getenv(...)`・`os.environ` の `setdefault`・`pop`、 `"NAME" in os.environ`。TypeScript は `process.env.NAME`・`process.env["NAME"]`・`const { NAME } = process.env`。素の `=` による書き込みと `del`・`delete` は読みに数えない。`+=` は値を読むので数える |
| 対象にするソース | `git ls-files` が返すファイルのうち、`targets.json` のプラグインごとの `sources` の glob に合うもの。作業ツリーに無いファイルは飛ばす。`**` はドットで始まるディレクトリに合わないので、そこにあるソースは glob に `.claude/**/*.py` のようにドットのディレクトリを明示して書く。コメントだけの行と Python の三重引用符の中は読まない。行の後ろのコメントは外さない |
| 名前が決まらない読み | 名前が文字列のリテラルでない読みには、直前の行に `interface-env: NAME` を書く。複数の名前は空白かカンマで区切る。名前を読まない場合は `interface-env: none` と書く。無いと、`<file>:<line>: environment: reads an environment variable by a name that is not a literal; write "interface-env: NAME" on the line before it, or "interface-env: none" if it reads no name` で止める |
| `*` | `environment` の名前には 1 つだけ書ける。両側に固定の文字が要る。`PECOT_GITHUB_*_TOKEN` は使え、`PECOT_*` は使えない。`*` は 1 文字以上の `A-Z`・`0-9`・`_` に合う |
| 対象のプラグイン | `targets.json` で `entries` が `complete` のプラグインだけ。`partial` のプラグインの環境変数は確かめない |

検出の限界は次のとおり。

- `interface-env:` のコメントが古くなっても見つけられない
- 次の形は、名前が決まらない読みとして止める。`interface-env:` で名前を書く
  - `from os import environ, getenv` と `import { env } from "node:process"`
  - `const e = process.env` のような別名への代入
  - `os.environ.copy()` や `{ ...process.env }` などの丸ごとの参照
- Python の三重引用符を除く文字列の中と、テンプレート文字列の中の `process.env.A` や `os.environ` は、コードと区別できず読みに数える。`os.environb` は読まない
- 名前を変数で組み立てる読みは、`interface-env:` に頼る
- 読み込めない状況（git のリポジトリでない・ファイルを読めない）は、`error: <path>: <原因>` の 1 行と終了コード 2 で止める。終了コード 1 は指摘があるときだけである

## 一致の確認が出す失敗

```text
error: plugins/pecot-workflow/interface/generated.json is stale
  PW-ISSUE-CREATE: input.properties.label: added
  PW-PR-CREATE: input.properties.draft.default: false -> true
  run: plugins/pecot-workflow/scripts/interface/export.py --write
```

## つなぎの確認が出す失敗

```text
error: plugins/pecot-tools/cli/tests/integration/tools-read.test.ts:294: PT-AWS-S3-LS-09 is not defined
error: PW-ISSUE-CREATE-02 has no test
```

## 版

`format` は整数で、欄の意味を変えるときに上げる。読み込みは、知らない `format` を拒む。
