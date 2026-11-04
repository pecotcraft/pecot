# fake aws の fixture

偽 awscli（`../aws`）が読む出力データ。1 件は 3 ファイルで構成する。
3 ファイルは `<name>.stdout` / `<name>.stderr` / `<name>.exit` で、いずれも省略できる（省略時は stdout 空・stderr 空・exit 0）。既定の `<name>` は
`<service>-<subcommand>`。`FAKE_AWS_FIXTURE` で明示すると任意の名前を選べる。同名の n 回目の
呼び出しは `<name>.<n>.<ext>` を優先する。

`FAKE_AWS_EXIT_WHEN_FILE` で待機させたとき、`<name>.after.stdout` があれば、
待機が解けた後に追加で出力する。SSO のデバイス認証が完了して成功行が続く場合に使う。

## 出所

| 種別 | fixture | 出所 |
|---|---|---|
| 失敗 | `no-credentials` / `profile-not-found` / `sso-token-expired` / `invalid-token` / `invalid-input` / `s3-cp-no-credentials` | 実 awscli 2.36.40 の出力（採取日 2026-09-07）|
| 失敗 | `access-denied` / `resource-not-found` | **仮置き**。実アカウントが要るため未採取。`aws: [ERROR]: An error occurred (<Code>) when calling the <Op> operation: …` の骨格だけ実採取に合わせ、エラーコードと終了コードは research R4 の表から転記 |
| 成功 | `sts-get-caller-identity` / `s3-ls` / `paginated` / `sequence` | 手書き。実 API の応答形に合わせた最小データ |
| SSO | `sso-login` / `sso-login.no-config` | 実 awscli 2.36.40 の出力（採取日 2026-09-07）。`sso-login.stdout` は start URL と認証コードをダミー（`example.awsapps.com` / `ABCD-EFGH`）へ置換済み |
| SSO | `sso-login.after` | 実 awscli 2.36.40 の出力（採取日 2026-09-07）。承認後に続く成功行で、`.pecot/work/1055/capture/sso-login.completed.real.stdout` の末尾行と一致する（start URL はダミーへ置換）|
| SSO | `sso-login.cached` | **合成**。prompt を出さずに exit 0 で終わる場合。2.36.40 は `--use-device-code` 指定時にキャッシュトークンの有無に依らず毎回デバイスフローへ入る。そのため実機では観測されず、防御用の分岐のテストに置いている |
| SSO | `sso-login.silent` | **意図的に不在**。URL / コードが永久に確定しない状態（出力の無い場合）のテストが、この名前の fixture が存在しないことに依存している。追加しない |
| 成功 | `lambda-list-functions` / `lambda-get-function-configuration` / `logs-describe-log-groups` / `logs-describe-log-streams` / `logs-get-log-events` / `logs-filter-log-events` / `sqs-list-queues` / `sqs-get-queue-attributes` / `athena-start-query-execution` / `athena-get-query-execution` / `athena-get-query-results` / `s3api-get-object` / `s3-cp` / `lambda-list-event-source-mappings` / `cloudwatch-get-metric-statistics` / `rds-describe-events` / `rds-describe-db-clusters` / `rds-describe-db-instances` / `scheduler-list-schedules` / `scheduler-get-schedule` / `ecr-describe-images` / `ec2-describe-instances` | **仮置き**。awscli リファレンスの出力例に合わせたフィールド構成で、値はダミー（アカウント 123456789012・リージョン ap-northeast-1）|

仮置きの fixture が固定しているのは「応答のフィールド構成」までで、実アカウントの値そのものではない。
実 API との差は、実 awscli を使う `tests/integration/real-awscli.test.ts` で埋めます。
awscli 導入端末での手動確認（quickstart の US1）でも埋めます。

## 採取手順

資格情報を持つ端末で、他の設定に汚されない環境を作ってから実行する。

```bash
name=logs-describe-log-groups
dir=plugins/pecot-tools/cli/tests/_fixtures/fake-aws/fixtures

export HOME="$(mktemp -d)"
export AWS_CONFIG_FILE="$HOME/config"
export AWS_SHARED_CREDENTIALS_FILE="$HOME/credentials"
aws configure sso   # 採取に使う profile だけを作る

aws logs describe-log-groups --output json --no-cli-pager --region ap-northeast-1 \
  > "$dir/$name.stdout" 2> "$dir/$name.stderr"
echo $? > "$dir/$name.exit"
```

採取後は次を確認してから差し替える。

- アカウント ID・ARN・バケット名・キュー URL・ログ本文を実在しない値へ置き換える
- 終了コード 0 の成功 fixture では空の `.stderr` / `.exit` を消す（3 ファイルとも省略可）
- 本 README の表で当該 fixture の行を「仮置き」から「実採取（採取日）」へ直す
