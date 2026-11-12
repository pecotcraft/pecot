# Contract: 前後比較のシナリオ

置き場は `plugins/pecot-workflow/cli-node/tests/parity/`。

```text
tests/parity/
├── scenarios/<id>.yaml   # 入力（command、setup、github）
├── golden/<id>.json      # Python の CLI の実出力から作る期待値
├── baseline.json         # 基準値（data-model.md の Baseline）
├── record.ts             # Python の CLI でシナリオを流し、golden を書く
└── parity.test.ts        # Node の CLI（直接と MCP 経由）でシナリオを流し、golden と比べる
```

## シナリオ

```yaml
id: issue-create-ok-basic
command:
  path: [issue, create]
  args: ["body.md"]
stdin: ""                # 省略できる。標準入力に流す文字列
setup:
  repo:
    branch: feat/123
    files: { body.md: "..." , .pecot/config/projects/.active: "..." }
  cwd: "."               # 省略できる。repo の中で実行するディレクトリ
  data: { config/hosts.json: "..." }
  env: { PECOT_GITHUB_GHES_EXAMPLE_COM_TOKEN: dummy-token }
  ghToken: ...           # 省略できる。gh stub が返すトークン
github:
  - match: { method: POST, path: /graphql, operation: CreateIssue }
    respond: { status: 200, body: { ... } }
    times: 1             # 省略できる。応答を返せる回数
```

ファイルの名前は `<コマンドの path>-<kind>-<名前>.yaml`。kind は `ok`・`usage`・`auth`・`4xx`・`5xx`・`state` のどれか。

## golden

| キー | 内容 |
|---|---|
| `stdout` / `stderr` | 文字列。時刻・一時パス・トークンは固定の文字に置き換える |
| `exitCode` | 数値 |
| `requests` | 偽の GitHub サーバが受けた要求の列（メソッド、パス、GraphQL の operation 名と変数、REST の本文） |
| `files` | 終わった後の `.pecot/` とデータ置き場の中身（`venv/` と `runtime/` を除く） |

## 流し方

| 段階 | 誰が | 何を |
|---|---|---|
| 記録 | `record:parity` を手で起動 | Python の CLI（`PECOT_BOOTSTRAP_SKIP=1`、`PECOT_GITHUB_API_URL` を偽サーバへ）でシナリオを流して golden を書く。使うのは、Python の CLI か依存を変える PR だけ（spec FR-007）。対象はその変更で出力が変わるシナリオに限る |
| 点検 | `record:parity:check` を手で起動 | golden を書かずに、今の Python との差を出す。Python を変える PR で、記録し直す対象を見つけるときに使う |
| 比較 | `test-cli` レーン | Node の CLI を直接起動した結果は全件、MCP クライアントからツールを呼んだ結果は「MCP に写せるシナリオ」の全件を、それぞれ golden と比べる |
| Python の削除後 | `test-cli` レーン | `record.ts` を消す。golden は Node の回帰テストの期待値として残す |

## MCP 経由で流す対象

CLI の直接起動は全件（228 件）。MCP 経由は「MCP に写せるシナリオ」の全件。

次の 3 種は MCP 経由で流さないので除く。2026-11-12 の時点の件数は 50 件、残りは 178 件。

| 除く種類 | 件数 | 理由 |
|---|---|---|
| `global-*` | 31 | `--help`・`--version`・`--show-repo`・未知のコマンド・引数なしは、ツールの呼び出しに写せない |
| 名前に `usage` を含むもののうち、入力に写せないもの | 3 | 未知のフラグなど、argv を入力に写せない |
| 名前に `usage` を含むもののうち、入力の検証で断られるもの | 13 | 必須の欠けなど。入力には写せるが、MCP が `invalid input:` で断り、本体を呼ばない（`_meta` が無い） |
| 標準入力を使う `worktree-link-*-overwrite-confirmed`・`-declined`・`-eof` | 3 | MCP のツールは標準入力を持たない |

- 除く一覧と理由の種類（写せない・検証で断られる）は `parity.test.ts` が持つ。一覧に無い `usage` のシナリオ（13 件）は MCP 経由で流し、golden と比べる
- 同じテストで、写せないものは例外になることを見る
- 断られるものは、本文が `invalid input:` で始まり、`_meta` を持たないことを見る
- 一覧が実物とずれたら、テストが落ちる
- CLI の引数の誤りのうち、入力に写せないものと入力の検証で断られるものは、MCP では golden と同じ出力にならない- 入力の検証の誤りは、フェーズ 7 のツール一覧のテストが受け持つ
- `worktree_link` の `force` が false のときの中止（入力の終端と同じ結果）は、フェーズ 7 のツールの単体テストが受け持つ

### argv からツールの入力への写し方

| argv の要素 | ツールの入力 |
|---|---|
| 位置引数 | 定義書の `cli.positional` の順に、同じ名前の入力へ入れる |
| フラグ `--<name>` | 名前の `-` を `_` にした入力へ入れる。値を取らないフラグは `true` |
| 短い形（`-D` など）と `--no-<name>` | 定義書の `cli.flags` の欄で入力の名前に引く。`--no-` の形は `false` |
| グローバルの `--repo` | 入力 `repo` |

### 比べる欄

結果の `_meta['io.github.pecotcraft/outcome']` の `stdout`・`stderr`・`exitCode` を、golden の同じ名前の欄と比べる。golden の `requests` と `files` も、直接起動と同じく比べる。

## 規則

- 定義書にあるサブコマンドのそれぞれに、正常系と失敗系（認証切れ、GitHub の 4xx / 5xx、引数の誤り）を 1 件以上
- golden を Node に合わせて書き換えない。差が出たら Node 側を直す。例外は、下の help の 4 件の stdout だけ
- golden を記録し直す PR では、Node 側も同じ PR で直し、`parity.test.ts` を通す
- `*-python-state` のシナリオ（Python が書いた形の状態を Node が読む）は 3 件。issue の分は無い
  - `project-info-ok-python-state` はフェーズ 2 で確かめる
  - `session-status-ok-python-state` はフェーズ 3 で確かめる
  - `worktree-add-ok-python-state` はフェーズ 5 で確かめる
- `global-*` は、フェーズ 2〜5 の対象から外す。31 件のうち 24 件は今も一致している
- 残りの 7 件のうち 3 件（「近いコマンド」の案内とコマンドの欠け）は、34 個がそろったフェーズ 6 から一致を確かめている
- help を stdout に出す 4 件は、stdout を golden と比べない（`parity.test.ts` の `SCENARIOS_WITH_NODE_HELP`）
  - `global-ok-help`・`global-ok-help-group`・`global-ok-help-after-double-dash`・`global-usage-no-args`
  - help の書式は Node で決める（#362）。stdout の中身は `src/commands/tests/help.test.ts` が確かめる
  - 終了コード・stderr・`requests`・`files` は、ほかのシナリオと同じく golden と比べる
- `parity.test.ts` は、この 4 件の stdout を除く全件を golden と比べる
- `PECOT_GITHUB_API_URL` は `http://127.0.0.1` と `http://localhost` だけを受け付ける。他の値なら CLI は起動時に失敗する
