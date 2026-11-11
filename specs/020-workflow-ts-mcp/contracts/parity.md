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
id: issue-create-basic
command: [issue, create, body.md]
setup:
  repo:
    branch: feat/123
    files: { body.md: "..." , .pecot/config.yaml: "..." }
  data: { config/hosts.json: "..." }
  env: { GITHUB_TOKEN: dummy }
github:
  - match: { method: POST, path: /graphql, operation: CreateIssue }
    respond: { status: 200, body: { ... } }
```

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
| 比較 | `test-cli` レーン | Node の CLI を直接起動した結果と、MCP クライアントからツールを呼んだ結果を、それぞれ golden と比べる |
| Python の削除後 | `test-cli` レーン | `record.ts` を消す。golden は Node の回帰テストの期待値として残す |

## 規則

- 定義書にあるサブコマンドのそれぞれに、正常系と失敗系（認証切れ、GitHub の 4xx / 5xx、引数の誤り）を 1 件以上
- golden を Node に合わせて書き換えない。差が出たら Node 側を直す
- golden を記録し直す PR では、Node 側も同じ PR で直し、`parity.test.ts` を通す
- `PECOT_GITHUB_API_URL` は `http://127.0.0.1` と `http://localhost` だけを受け付ける。他の値なら CLI は起動時に失敗する
