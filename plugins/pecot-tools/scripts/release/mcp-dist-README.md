# @pecot/tools-mcp

pecot-tools プラグインの MCP サーバを、npm のパッケージとして単体で配布したものです。プラグインを導入していない環境でも、
MCP クライアントに 1 エントリ登録するだけで pecot-tools のツールが使えます。

公開するのは許可リストで限定した awscli コマンドだけです。許可リストに無いコマンド、S3 への
アップロード方向の指定、Athena の変更系クエリは、awscli を起動する前に拒否します。

## 前提

- Node.js 24 系は 24.22.1 以上、26 系は 26.12.1 以上（脆弱性の修正を含まない版では起動しません）
- awscli v2（2.22 以上）が PATH にあり、認証（SSO プロファイル等）が設定済みであること。
  ツールは awscli をそのまま起動する。シェルで `aws sts get-caller-identity` が通る状態を前提にする
- Windows ネイティブ環境は対象外です（Linux / macOS / WSL2 で使用してください）

## 登録

使用する MCP クライアントの設定に次の 1 エントリを追加します。

```json
{
  "mcpServers": {
    "pecot-tools": {
      "command": "npx",
      "args": ["-y", "--prefix=/", "@pecot/tools-mcp"]
    }
  }
}
```

`--prefix=/` は、pnpm の `devEngines` を宣言したリポジトリの中で起動しても止まらないようにするための指定です。
`--prefix` を付けないと、そのリポジトリを cwd にした npx が `EBADDEVENGINES` で止まります。
npm には、`devEngines` の判定だけを外す公式の手段がありません。

パッケージは `--package=` ではなく位置引数で渡します。
`--package=` で渡すと環境変数 `npm_config_package` が子プロセスに残り、子の npx が別のパッケージを実行してしまうためです。

`--prefix=/` には次の副作用があります。

- 利用者のリポジトリの `.npmrc` を読まず、globalconfig も `/etc/npmrc` になる。registry・proxy・cafile は `~/.npmrc` に置く
- `npm_config_prefix=/` がサーバに引き継がれる

この副作用を避けたいときは、先に `npm i -g @pecot/tools-mcp` で入れて、コマンドを直接登録します。

```json
{
  "mcpServers": {
    "pecot-tools": {
      "command": "pecot-tools-mcp"
    }
  }
}
```

Windows の MCP クライアントから使う場合は WSL2 経由で起動します。

```json
{
  "mcpServers": {
    "pecot-tools": {
      "command": "wsl",
      "args": ["npx", "-y", "--prefix=/", "@pecot/tools-mcp"]
    }
  }
}
```

WSL 内の npx が非ログインシェルの PATH に無い場合は、`args` を差し替えます。
差し替え後は `"args": ["-e", "bash", "-lc", "npx -y --prefix=/ @pecot/tools-mcp"]` です。

版を固定するときは、`@pecot/tools-mcp@1.2.3` のように版を付けます。
依存は `npm-shrinkwrap.json` で固定されているため、同じ版なら同じ依存が入ります。

## 初回の操作

SSO で認証するときは、開始と完了確認の 2 つのツールを順に呼びます。

1. `aws_sso_login`（任意で `profile`）を呼ぶ。応答の `data` に `verificationUrl` と `userCode` が
   返るので、URL をブラウザで開いてコードを入力し承認する
2. `aws_sso_login_status`（同じ `profile`）を呼ぶ。`state` が `completed` になれば認証済み
3. 以降は `aws_sts_get_caller_identity` 等の各ツールを同じ `profile` で呼ぶ

開始から 10 分で `timed-out` になります。`timed-out` と `failed` のときは `aws_sso_login` を
呼び直してください。

## ツール

| ツール | awscli | 種別 | 読取専用 | ページング |
|---|---|---|---|---|
| `aws_sso_login` | `sso login` | auth | false | - |
| `aws_sso_login_status` | （子プロセス状態の参照） | auth | true | - |
| `aws_sts_get_caller_identity` | `sts get-caller-identity` | read | true | - |
| `aws_lambda_list_functions` | `lambda list-functions` | read | true | max-items |
| `aws_lambda_get_function_configuration` | `lambda get-function-configuration` | read | true | - |
| `aws_lambda_list_event_source_mappings` | `lambda list-event-source-mappings` | read | true | max-items |
| `aws_logs_describe_log_groups` | `logs describe-log-groups` | read | true | max-items |
| `aws_logs_describe_log_streams` | `logs describe-log-streams` | read | true | max-items |
| `aws_logs_get_log_events` | `logs get-log-events` | read | true | limit / next-token |
| `aws_logs_filter_log_events` | `logs filter-log-events` | read | true | max-items |
| `aws_cloudwatch_get_metric_statistics` | `cloudwatch get-metric-statistics` | read | true | - |
| `aws_sqs_list_queues` | `sqs list-queues` | read | true | max-items |
| `aws_sqs_get_queue_attributes` | `sqs get-queue-attributes` | read | true | - |
| `aws_athena_start_query_execution` | `athena start-query-execution` | execute | false | - |
| `aws_athena_get_query_execution` | `athena get-query-execution` | read | true | - |
| `aws_athena_get_query_results` | `athena get-query-results` | read | true | max-items |
| `aws_s3_ls` | `s3 ls` | read | true | - |
| `aws_s3_cp` | `s3 cp <s3_uri> <local_path>` | fetch | false | - |
| `aws_s3api_get_object` | `s3api get-object` | fetch | false | - |
| `aws_rds_describe_events` | `rds describe-events` | read | true | max-items |
| `aws_rds_describe_db_clusters` | `rds describe-db-clusters` | read | true | max-items |
| `aws_rds_describe_db_instances` | `rds describe-db-instances` | read | true | max-items |
| `aws_scheduler_list_schedules` | `scheduler list-schedules` | read | true | max-items |
| `aws_scheduler_get_schedule` | `scheduler get-schedule` | read | true | - |
| `aws_ecr_describe_images` | `ecr describe-images` | read | true | max-items |
| `aws_ec2_describe_instances` | `ec2 describe-instances` | read | true | max-items |

全ツールが任意入力 `profile` と `region` を持ちます。指定したときだけ `--profile` / `--region` を
付けて awscli を起動します。

## 失敗したとき

失敗した応答は `category` に理由の種別を持ちます。

| category | 内容と対処 |
|---|---|
| `not-allowed` | 許可リストに無い操作。公開しているツールの範囲で実行する |
| `invalid-input` | 入力が書式・制約に合わない。message の指摘に従って入力を直す |
| `awscli-missing` | awscli が見つからない。awscli v2（2.22 以上）を導入して PATH を通す |
| `auth-missing` | 認証設定が無い。`aws_sso_login` を実行するか `profile` を指定する |
| `auth-expired` | 認証の有効期限切れ。`aws_sso_login` で再認証する |
| `permission-denied` | 権限不足。`profile` と AWS 側のロール・許可セットを確認する |
| `resource-not-found` | 対象が無い。名前とリージョンを確認する |
| `timeout` | 時間切れ。取得範囲を狭めて再実行する |
| `other` | 上記以外。応答の `stderr` を確認する |

サーバが起動しないときは、次を確認します。

- `EBADDEVENGINES` で止まるときは、登録の `args` に `--prefix=/` が付いているか確認する

## 版

npm の版は pecot-tools プラグインの版と一致します。
