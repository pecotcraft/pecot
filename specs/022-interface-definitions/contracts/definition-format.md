# Contract: 定義書の形式

プラグインごとに `plugins/<plugin>/interface/` を置く。形式の正は `libs/interface-spec` の zod の定義で、この文書はその読み方を示す。

## 欄が従う枠組み

1 ツール・1 action に書く欄は、POSIX（IEEE Std 1003.1-2024）のユーティリティ記述の節立てに対応づける。POSIX に節の無い欄は、借りた先を書く。

実装の後は、この対応の正を `libs/interface-spec/src/domain/field-map.ts` に置く。形式の定義の欄がすべて表にあることを、テストが確かめる。表示の HTML にも同じ表を出す。

| POSIX の節 | 定義書の欄 | 書き手 | MCP ツールでの読み替え |
|---|---|---|---|
| NAME | `id`・`name`・`description`・`summary`・`mcp.title` | 書き出し。`summary` は人 | Tool の `name`・`title`・`description` |
| SYNOPSIS | `constraints`・`surfaces.mcp.tool`・`surfaces.action.path` | 書き出し。`constraints` は人 | `surfaces.mcp.tool` |
| DESCRIPTION | `details` | 人 | 同じ |
| OPTIONS・OPERANDS | `input`・`arguments`・`default_notes` | 書き出し。`arguments`・`default_notes` は人 | Tool の `inputSchema` |
| STDIN | `stdin` | 人 | 常に `none` |
| INPUT FILES・OUTPUT FILES | `effects` | 人 | 同じ |
| ENVIRONMENT VARIABLES | `environment` | 人。ソースの文字列と比べる | 同じ |
| ASYNCHRONOUS EVENTS | 欄にしない。全項目が既定の扱い | — | — |
| STDOUT | `output`・`mcp.output`・`mcp_output.fields`・`action.outputs` | `output` は人。MCP ツールの形と action の `outputs` は書き出し、ツールの項目の説明は人 | Tool の `outputSchema` と結果の構造。`output` は常に `format: none` |
| STDERR | `diagnostics` | 人 | 常に `default`。失敗の文は `exit_status`、警告は `details` に書く |
| EXIT STATUS | `exit_status` | 人 | 失敗の種別 |
| CONSEQUENCES OF ERRORS | `on_error` | 人 | 同じ |
| EXAMPLES | `examples` | 人 | `tools/call` の `arguments` |
| FUTURE DIRECTIONS | `deprecated` | 書き出し | 同じ |
| CHANGE HISTORY | 欄にしない。各プラグインの CHANGELOG が担う | — | — |

| POSIX に節の無い欄 | 借りた先 |
|---|---|
| `effects` の `kind`（相手を問わない）・`idempotent`・`mcp.annotations` | MCP の Tool の annotations（`readOnlyHint`・`destructiveHint`・`idempotentHint`・`openWorldHint`） |
| `prerequisites` | 設計契約の事前条件。呼ぶ側が満たす |
| `behaviors` | 要件の書き方（EARS）と、要件とテストの双方向の追跡 |
| `hidden` | このリポの決め。利用者の一覧に出さない項目を表す |

相手が `file` の effect が POSIX の INPUT FILES・OUTPUT FILES に対応するのは、ファイルの一覧としてだけだ。`kind` の意味は、相手を問わず MCP の annotations に従う。

| `kind` | 意味 | annotations |
|---|---|---|
| `read` | 環境を変えない | 全部が `read` なら `readOnlyHint: true` |
| `write` | 足すだけ。新しく作る・足す・空の欄に値を入れる | `destructive` が無ければ `destructiveHint: false` |
| `destructive` | 既にあるものを書き換える・置き換える・消す。閉じる・マージするなど、状態を変えることも含む | 1 つでもあれば `destructiveHint: true` |

MCP の面を持つ項目は、`readOnlyHint` を省かない。`write`・`destructive` を持つ項目は、`destructiveHint`・`idempotentHint` も省かない。`idempotentHint` は `idempotent` と同じ値にする。

足す操作と上書きを 1 つの操作で行うときは、effect を 2 つに分け、足す部分を `write`、上書きの部分を `destructive` にする。

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
      "name": "issue_create",
      "description": "Create an issue from a Markdown file with front matter.",
      "surfaces": { "mcp": { "tool": "issue_create" } },
      "hidden": false,
      "deprecated": false,
      "input": {
        "type": "object",
        "properties": {
          "file": { "type": "string", "description": "Markdown file to post." },
          "type": { "type": "string", "enum": ["task", "bug", "epic", "tracker"], "default": "task", "description": "Issue type." }
        },
        "required": ["file"],
        "additionalProperties": false
      },
      "mcp": {
        "title": "Create Issue",
        "output": {
          "type": "object",
          "properties": {
            "url": { "type": "string", "description": "URL of the created issue." },
            "kind": { "type": "string", "description": "Failure kind (failure only)" },
            "detail": { "type": "string", "description": "Full failure text (failure only)" },
            "log": { "type": "string", "description": "Raw output of a child process (failure only)" },
            "warnings": { "type": "array", "items": { "type": "string" }, "description": "Warning messages" }
          },
          "additionalProperties": false
        }
      }
    }
  ]
}
```

| 決め | 内容 |
|---|---|
| `id` | `<prefix>-<名前を大文字にし、空白と`_` を `-`にしたもの>`。接頭辞は pecot-workflow が `PW`、pecot-tools が `PT`、pecot-visual が `PV`、actions が `PA` |
| `input` の名前 | MCP ツールは `tools/list` の `inputSchema` の名前。action は `action.yml` の `inputs` の名前 |
| `input` の型 | JSON Schema 2020-12。MCP ツールは `tools/list` の `inputSchema` をそのまま入れる。action は `action.yml` の `inputs` から作る |
| 既定値 | 固定の値だけを `default` に入れる。実行時に決まるものは入れず、`authored.yaml` の `default_notes` に書く |
| `surfaces` | MCP ツールは `mcp.tool`、GitHub Actions の action は `action.path`（action のディレクトリ）。少なくとも一方を持つ |
| MCP ツールの出力と注釈 | `tools/list` の `outputSchema` を `mcp.output` に、`annotations` を `mcp.annotations` に入れる |
| action の outputs | `action.yml` の `outputs` を `action.outputs` に入れる。キーは output の名前、値は `action.yml` の `description` |
| MCP ツールの表示名 | `tools/list` の Tool の最上位の `title` を `mcp.title` に入れる。MCP の面を持つ項目では必須。英語で、4 語以内が目安。`annotations.title` は使わない |

### `resources`

MCP サーバが静的な resource を出すプラグインは、最上位に `resources` を持つ。出さないプラグインは欄を省く。

```json
{
  "resources": [
    {
      "uri": "pecot-template://issue/task",
      "name": "issue-task",
      "title": "Task issue",
      "description": "The body template of a task issue.",
      "mimeType": "text/markdown"
    }
  ]
}
```

| 決め | 内容 |
|---|---|
| 要素の欄 | `resources/list` の `Resource` のうち `uri`・`name`・`title`・`description`・`mimeType`。`uri`・`name` は必ず書き、ほかは実装が持つときだけ書く |
| 並び | 書き出す側の順（`resources/list` の順） |
| `uri` | ファイルの中で重ならない |
| `name`・`description` の言語 | 英語。実装の文字列をそのまま入れる |

### 決定性の決め

書き出しは、同じ実装から、いつも同じバイト列を出す。

| 対象 | 決め |
|---|---|
| 項目の並び | `id` の順 |
| 項目のキーの順 | `id`・`name`・`description`・`surfaces`・`hidden`・`deprecated`・`input`・`mcp`・`action` |
| `input.properties` のキー | 名前の順 |
| 引数の中のキーの順 | `type`・`items`・`enum`・`minimum`・`maximum`・`default`・`description` |
| `required` | 名前の順。必須が無くても `[]` を書く |
| `additionalProperties` | 常に `false` |
| 書き方 | 字下げ 2 の JSON と、末尾の改行 1 つ。文字はエスケープしない |

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
    constraints: []
    details:
      - Creates one issue from the file and adds it to the project board.
      - Returns the URL of the created issue.
    stdin: none
    output:
      format: none
    mcp_output:
      fields:
        url: 作った Issue の URL
    diagnostics: default
    environment: []
    exit_status:
      - kind: invalid-front-matter
        when: The front matter is invalid.
      - kind: github-api
        when: The GitHub API returned an error.
    on_error: The issue is not created, and the board is not changed.
    effects:
      - target: github
        kind: write
        what: Creates an issue and adds it to the project board.
      - target: file
        kind: read
        what: Reads the Markdown file given as file.
    prerequisites:
      - gh is authenticated for the target repository.
    idempotent: false
    examples:
      - arguments:
          file: .pecot/work/199/issue.md
        note: Create one issue from a file.
    default_notes:
      repo: Resolved from the git remote of the current directory.
    behaviors:
      - id: PW-ISSUE-CREATE-01
        pattern: unwanted
        statement: もしフロントマターに type が無いなら、Issue を作らずに失敗の種別 invalid-front-matter を返す
      - id: PW-ISSUE-CREATE-02
        pattern: event
        statement: file を渡して呼ぶと、その内容で Issue を 1 件作り、URL を返す
common_behaviors:
  - id: PW-COMMON-01
    pattern: unwanted
    statement: もし知らない引数を渡したなら、失敗の種別 invalid-input を返す
```

欄ごとの型・言語・使わないときの値は [data-model.md](../data-model.md) にある。`mcp_output` のほかの欄は省けない。

### `examples`

`examples` の要素は、`arguments` と `note` を持つ。キーは `input.properties` にあり、`input.required` を全部持つ。

| 項目 | `arguments` の意味 |
|---|---|
| MCP の面を持つ | `tools/call` の `params` の `arguments` |
| action の項目 | ワークフローの step の `with:` の入力 |

```yaml
    examples:
      - arguments:
          issue_ref: example-org/my-repo/123
          status: backlog
        note: Issue をボードに足し、Status を `backlog` にします。
```

表示は、MCP の項目ではツール名を `name` に入れた `tools/call` の `params` の形（`{"name": ..., "arguments": {...}}`）で描く。action の項目では、`uses:` と `with:` を持つ step の形で描く。

### 面で変わる欄

MCP の面を持つ項目は、標準入出力を使わない。`stdin`・`diagnostics`・`output` は、決まった値だけを受ける。

| 欄 | MCP の面を持つ項目 | action の項目 |
|---|---|---|
| `stdin` | `none` | step が標準入力から読むものと、その形 |
| `output` | `format: none`。結果は `mcp_output` で説明する | step の標準出力の形 |
| `diagnostics` | `default`。警告は `details`、失敗の文は `exit_status` に書く | step が標準エラーに出すもの |
| `exit_status` | `kind` と `when` | 同じ |

action の項目のページは、「出力」の節に step のログと `action.outputs` の表を出し、`stdin`・`diagnostics` が既定でなければ「標準入力」「標準エラー」を足す。MCP の項目のページは、標準入出力を出さない。

### `mcp_output`

MCP ツールの結果の `structuredContent` に、ツールごとに返す項目を、人の言葉で説明する欄だ。

```yaml
    output:
      format: none
    mcp_output:
      fields:
        branch: 作ったブランチの名前
        workDirectory: 作業ディレクトリの絶対パス。dry_run では返さない
    diagnostics: default
```

| 決め | 内容 |
|---|---|
| 置き場所 | 項目の中の `output` の後。MCP の面を持つ項目だけに書く |
| `fields` のキー | `mcp.output` の最上位の `properties` から、全ツールに共通の 4 項目を除いたものと、同じ集まりにする |
| `fields` の値 | 項目ごとの説明の文。言語は `prose` に従う |
| 省いたとき | MCP の面を持つ項目は、省くと `error` になる（返す項目が無いときは `fields: {}` と書く） |

`mcp.output` の最上位は、閉じた型（`additionalProperties: false`）にする。閉じていない型は、`validate` が `generated.json` の行で止める。

全ツールに共通の項目（`kind`・`detail`・`log`・`warnings`）は、`mcp_output` に書かない。ファイルの最上位の `common_mcp_output` に書く。

### `common_mcp_output`

全ツールに共通の 4 項目を、プラグインごとに 1 か所で説明する欄だ。`common_behaviors` と同じ階層に書く。

```yaml
common_mcp_output:
  fields:
    kind: 失敗の種別。失敗のときだけ入る
    detail: 失敗の全文。失敗のときだけ入る
    log: 子プロセスの出力。失敗のときだけ入る
    warnings: 警告の文の配列。警告が無いときは入らない
```

| 決め | 中身 |
|---|---|
| `fields` のキー | `kind`・`detail`・`log`・`warnings` の 4 つと、同じ集まりにする |
| `fields` の値 | 項目ごとの説明の文。言語は `prose` に従う |
| 省いたとき | MCP の面を持つ項目があるプラグインは、省くと `error` になる。MCP の面を持つ項目が無いプラグインは、書くと `error` になる |

プラグインの共通仕様のページは、この欄から「出力」の節を作る。各ツールのページの「出力」は、その節へリンクする。

`requires` のキーの引数を渡すときは、値に並べた引数がすべて要る。

### `resources`

`generated.json` の resource ごとに、日本語の説明を書く欄だ。キーは `uri` にする。

```yaml
resources:
  pecot-template://issue/task:
    summary: タスクの Issue の本文のテンプレート
```

| 決め | 中身 |
|---|---|
| キー | `generated.json` の `resources` の `uri` と、同じ集まりにする |
| `summary` | resource の説明の文。言語は `prose` に従う。空白だけは空とみなす |
| 省いたとき | `generated.json` に `resources` があるプラグインは、欠けた `uri` ごとに `error` になる。`resources` が無いプラグインは、書くと `error` になる |

プラグインのリソース一覧のページは、この欄の `summary`（無ければ `generated.json` の `description`）を説明の列に出す。

## 振る舞いの項目の文の型

文は EARS の 5 つの型のどれかで書く。主語（コマンド・ツールの名前）は書かず、項目の ID で補う。日本語の形は、このリポの規約だ。

| `pattern` | EARS の型 | 日本語の形 | 例 |
|---|---|---|---|
| `ubiquitous` | Ubiquitous | 「常に、〜する」 | 常に、結果に作った Issue の URL を含める |
| `event` | Event-driven（When） | 「〜すると、〜する」 | `dry_run` を付けて呼ぶと、GitHub に書かずに予定の行を出す |
| `state` | State-driven（While） | 「〜の間、〜する」 | 作業中の Issue がある間、別の Issue のブランチを作らない |
| `unwanted` | Unwanted behaviour（If / then） | 「もし〜なら、〜する」 | もし認証が切れているなら、失敗の種別 auth-expired を返す |
| `optional` | Optional feature（Where） | 「〜が有効なら、〜する」 | ロードマップリポの設定が有効なら、Epic をそのリポに作る |

| 決め | 内容 |
|---|---|
| 1 文 1 要件 | 契機と応答を 1 組だけ書く。応答が 2 つあるときは、項目を分ける |
| 観測できる応答 | 応答は、出力・終了の状態・副作用のどれかで確かめられる形で書く。「正しく処理する」のような語を使わない |
| 型と形の一致 | 形式の検証が、`pattern` と文の形（「〜と、」「〜の間、」「もし〜なら、」など）を比べる |

上の例の `PW-ISSUE-CREATE-01` は、応答が「作らない」と「失敗の種別を返す」の 2 つある。実物を書くときは、確かめたい応答ごとに項目を分ける。

## 形式の検証が出す失敗

失敗は 1 件 1 行で、ファイル・項目の ID・欄・理由を出す。

```text
error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-QUICK: entry is missing (present in generated.json)
error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE: on_error: field is missing (write "default" if nothing remains)
error: plugins/pecot-workflow/interface/authored.yaml: PW-ISSUE-CREATE: constraints[0].conflicts: unknown input name "mesage"
error: plugins/pecot-tools/interface/authored.yaml: PT-AWS-S3-LS-01: statement does not match pattern "unwanted"
error: plugins/pecot-tools/interface/authored.yaml: PT-AWS-S3-CP: effects has kind "write" but annotations.readOnlyHint is true
error: plugins/pecot-workflow/interface/authored.yaml: environment: PECOT_RESTACK is read by cli/src/commands/pr-restack.ts but not listed
```

形の誤りと意味の誤りは、同じ実行でそろえて出す。欄が足りない項目でも、その項目の振る舞いの項目は確認する。

実装が出す行は、次の形だ。`<file>` はリポジトリのルートからのパス。

| 場合 | 行 |
|---|---|
| 知らない欄 | `error: <file>: PW-ISSUE-CREATE: owner: unknown field` |
| 欄が無い | `error: <file>: PW-ISSUE-CREATE: on_error: field is missing (write "default" if nothing remains)`。「使わないときの値」がある欄だけ括弧を付ける。欄が空のときも同じ括弧を付ける |
| 欄が空（空白だけも含む） | `error: <file>: PW-ISSUE-CREATE: on_error: is empty (write "default" if nothing remains)`。括弧の付かない欄は `error: <file>: PW-ISSUE-CREATE: details[1]: is empty` |
| `statement` が空 | `error: <file>: PW-ISSUE-CREATE-02: statement: is empty`。日本語と `pattern` の確認は飛ばす |
| 型が違う（YAML の `null` を含む） | `error: <file>: PW-ISSUE-CREATE: on_error: expected string but got null` |
| 列挙の値が違う | `error: <file>: PW-ISSUE-CREATE: output.format: unknown value "bogus" (expected one of "text", "json", "none")` |
| 知らない `format` | `error: <file>: format: unknown value 2 (expected 1)` |
| 英語の欄に日本語 | `error: <file>: PW-ISSUE-CREATE: details[1]: contains Japanese text (write English)` |
| `statement` に日本語が無い | `error: <file>: PW-ISSUE-CREATE-01: statement: has no Japanese text (write Japanese)` |
| 振る舞いの項目の ID の形 | `error: <file>: PW-ISSUE-QUICK: behaviors[0].id: "PW-ISSUE-QUICK-1" must be "PW-ISSUE-QUICK-NN" (NN is 2 or more digits)`。共通の項目は `PT-COMMON-NN` |
| ID が重なる（同じファイル） | `error: <file>: PW-ISSUE-CREATE-01: id: is defined more than once` |
| ID が重なる（別のプラグイン） | `error: <file>: PW-COMMON-01: id: is also defined in <先に定義したファイル>` |
| `generated.json` に無い項目 | `error: <file>: PW-ISSUE-OLD: entry is not in generated.json (remove it)` |
| ファイルが無い | `error: <file>: file is missing` |
| `interface/` が無い | `error: plugins/<plugin>/interface: directory is missing (listed in libs/interface-spec/targets.json)` |
| YAML の構文 | `error: <file>:17: map keys must be unique`。JSON の構文も、位置が分かるときは `error: <file>:3: is not valid JSON`（位置が無いときは行番号なし）。alias の展開で読めない YAML は行番号なしで止める |
| `mcp_output.fields` のキーが足りない | `error: <file>: PW-SESSION-START: mcp_output.fields: is missing "branch" (present in mcp.output)` |
| `mcp_output.fields` のキーが余る | `error: <file>: PW-SESSION-START: mcp_output.fields: has "branchName" not in mcp.output (remove it)` |
| `mcp_output` の書き忘れ | `error: <file>: PW-SESSION-START: mcp_output: is missing (write each tool field in mcp.output, or an empty fields when it returns none)` |
| `mcp.output` が閉じていない | `error: <file>: PT-AWS-S3-LS: mcp.output: is not a closed type (declare every field the tool returns and set additionalProperties to false)` |
| `common_mcp_output` の書き忘れ | `error: <file>: common_mcp_output: is missing (write kind, detail, log and warnings in fields)` |
| `common_mcp_output.fields` のキーが足りない・余る | `error: <file>: common_mcp_output.fields: is missing "log"`、`error: <file>: common_mcp_output.fields: has "lines" that is not a common field (remove it)` |
| MCP の面の無いプラグインの `common_mcp_output` | `error: <file>: common_mcp_output: is only for plugins with an MCP surface (remove it)` |
| MCP の面の無い項目の `mcp_output` | `error: <file>: PW-ISSUE-CREATE: mcp_output: is only for entries with an MCP surface (remove it)` |
| `resources` の `uri` が重なる | `error: <file>: pecot-template://issue/task: uri: is defined more than once` |
| `authored.yaml` の `resources` の欠け | `error: <file>: pecot-template://pr/default: resource is missing (present in generated.json)` |
| `generated.json` に無い resource | `error: <file>: pecot-template://issue/old: resource is not in generated.json (remove it)` |
| resource の無いプラグインの `resources` | `error: <file>: resources: is only for plugins with resources in generated.json (remove it)` |
| MCP の面を持つ項目の `readOnlyHint` の書き忘れ | `error: <file>: PT-AWS-S3-LS: annotations.readOnlyHint is missing` |
| 書き込む項目の `destructiveHint`・`idempotentHint` の書き忘れ | `error: <file>: PT-AWS-S3-CP: effects has kind "write" but annotations.destructiveHint is missing`。`kind` は、項目が `write` を持てば `write`、持たなければ `destructive` |
| `mcp.title` の書き忘れ | `error: <file>: PT-AWS-S3-LS: mcp.title: is missing (give the tool a display name in English)` |
| MCP の面を持つ項目の `stdin` | `error: <file>: PT-AWS-S3-LS: stdin: must be "none" for an entry with an MCP surface (a tool reads its input only from the arguments)` |
| MCP の面を持つ項目の `diagnostics` | `error: <file>: PT-AWS-S3-LS: diagnostics: must be "default" for an entry with an MCP surface (write warnings in details and failure text in exit_status)` |
| MCP の面を持つ項目の `output.format` | `error: <file>: PT-AWS-S3-LS: output.format: must be "none" for an entry with an MCP surface (describe the result in mcp_output)` |
| 使用例の引数の名前 | `error: <file>: PT-AWS-S3-LS: examples[0].arguments: unknown input name "pth"`、`error: <file>: PT-AWS-S3-LS: examples[0].arguments: is missing the required input "path"` |
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

ファイルの先頭部（`format`・`plugin`・`prefix`・`names`）と `resources` の差は、項目の ID の代わりに `file:` を付けた行に出す（例: `file: resources[1]: added`）。

差の行の代わりに出す行と、ファイル全体の失敗は次のとおり。どれも終了コード 1 で、最後に `run:` の行を出す。

| 場合 | 行 |
|---|---|
| バイト列だけが違う（字下げ・改行コード） | `error: <file> is stale` の下に `generated.json: formatting differs` |
| 項目の形が違う（`entries` が配列でない・`id` が無い） | `error: <file> is stale` の下に `generated.json: unexpected structure` |
| JSON として読めない（UTF-8 でないものを含む） | `error: <file>: not valid JSON (<理由>)` |
| ファイルが無い | `error: <file>: file is missing` |

## つなぎの確認が出す失敗

```text
error: plugins/pecot-tools/cli/tests/integration/tools-read.test.ts:294: PT-AWS-S3-LS-09 is not defined
error: PW-ISSUE-CREATE-02 has no test
```

## 版

`format` は整数で、欄の意味を変えるときに上げる。読み込みは、知らない `format` を拒む。
