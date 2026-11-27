# Contracts: テストレポート

028 の [contracts/pages.md](../../028-pages-site/contracts/pages.md) に足す・変える決まりを書く。書いていない所は、028 のまま。

## URL

| 側 | レポート | 履歴 |
|---|---|---|
| リリース版 | `https://pecotcraft.github.io/pecot/test-report/` | S3 のバケットの `release/history.jsonl` に置き、公開しない（#822） |
| 開発版 | `https://pecotcraft.github.io/pecot/dev/test-report/` | 無い |
| PR 版 | 無い | 無い |

- 2026-11-26 に、履歴をリリース版だけにし、置き場所を S3 に改めた（spec の FR-018〜FR-020）

- 定義書の項目からのリンク: `<側の URL>test-report/index.html?tags=<要件の ID>`
- レポートのテストからのリンク: `<側の URL>permalink.html?id=<要件の ID>`

## レーンが残すもの

レポートのレーン（`report-lanes.json` の `results` を持つレーン）は、動かすたびに次を残す。

| 残すもの | 置き場所 | 決まり |
|---|---|---|
| Allure の結果 | `report-lanes.json` の `results` | レーンの最初に 1 回だけ空にする。レーンの中の 2 つ目からの実行は書き足す。nx の `outputs` に入れる。git には入れない |
| JUnit XML | 今の置き場所のまま | 今あるレーンだけ。中身は変えない |
| 実行の環境（`environment.properties`） | Allure の結果と同じディレクトリ | 実行全体で同じ値だけを書く。vitest は `OS`・`Node.js` を reporter の `environmentInfo` で書く。pytest は、ファイルが無いときだけ `OS` を書く（2026-11-27 に足した。#817） |
| テストを動かした版（ラベル） | 結果ごと | vitest は `Node.js`、pytest は `Python` のラベルを付ける。パラメータにすると、レポートの木の全行に版が出るので使わない（#817） |

環境変数:

| 名前 | 渡す人 | 値 |
|---|---|---|
| `PECOT_REPORT_SITE_URL` | `test-report.yml`（リリース版と、結果の無いレーンを main で流す開発版）と、`ci.yml` の workflow の env（PR とマージキューの run の両方に、開発版の URL） | 側の URL。渡さなければ `http://localhost:8000/`。末尾に `/` が無ければ足す |
| `PECOT_REPORT_HISTORY` | `generate.py` | `--history` を渡したときだけ、履歴のパス。Allure の設定（`allurerc.mjs`）が読む。`--history` を渡すのはリリース版だけ |
| `PECOT_REPORT_VARIABLES` | `generate.py` | 手元でない実行で、レーンごとの結果のコミットと run の URL（data-model の ReportVariables）の JSON。`allurerc.mjs` が `variables` にする |

bash のテストのレーンは、各プラグインの `scripts/ci/run-tests.sh` が `.githooks/scripts/test_report/bash-test.sh` を読み、テストのファイルを `bt_run_files` で 1 本ずつ動かす。

| 名前 | 置く人 | 値 |
|---|---|---|
| `PECOT_REPORT_RESULTS` | 各 `run-tests.sh`（シェルの変数。export しない） | nx のレーンから動いたときだけ、`<プラグイン>/test-results/<target>/allure-results`。`bt_run_file` が子のファイルに渡す |

- テストのファイルは確かめを `bt_*` で書き、確かめ 1 つに結果のファイルを 1 つ書く。成功と失敗で同じ題にする
- 落ちたファイルがあっても、レーンの最後のファイルまで動かす。レーンは落ちたファイルの一覧を出して 0 以外で終わる
- 終了コード・カバレッジの閾値の判定は、今のまま
- `pecot-workflow:test-hooks` の 2 回目（`env -i`）の実行は、Allure の結果を残さない

bats に移したレーン（#844 から）は、`run-tests.sh` が `.githooks/scripts/test_report/bats/run.sh` にファイルを渡す。
`run.sh` は、ファイルを 1 本ずつ `bats --jobs` で動かし、ファイルの中の `@test` を GNU parallel で並べる。`PECOT_REPORT_RESULTS` があれば、report formatter に Allure の結果を書かせる。

- `PECOT_REPORT_RESULTS` は `run.sh` を起こすときだけ渡す。`run.sh` は、bats とテストには渡さない
- `PECOT_BATS_REPORT`・`PECOT_BATS_ATTACHMENTS` は、`run.sh` が bats を起こすときだけ置く。`run.sh` は、添付のファイルを結果のディレクトリに移す
- `@test` 1 つに結果のファイルを 1 つ書く。説明は、`@test` の本体の先頭で呼ぶ `explains` が付ける
- 説明の無い passed の `@test` があれば、ファイルと題を並べて 0 以外で終わる
- 落ちたファイルがあっても、最後のファイルまで動かす。落ちたファイルの一覧を出して 0 以外で終わる

## `verifies`

```ts
verifies(context: AnnotatingContext, id: string): Promise<void>
```

`AnnotatingContext` は、vitest の `TestContext` のうち `annotate` だけを持つ形で、`TestContext` をそのまま渡せる。

| 残すもの | 形 |
|---|---|
| vitest の annotation | `context.annotate(id, 'verifies')`（今のまま。JUnit の `<property name="verifies">` になる） |
| Allure のリンク | 型 `tms`、名前は `id`、URL は `<PECOT_REPORT_SITE_URL>permalink.html?id=<id>` |
| Allure の tag | `id` |

- 置き場所は `libs/interface-spec/src/vitest/verifies.ts`。各プラグインの `tests/_helpers/verifies.ts` は re-export する
- 呼び方は変えない
- nx のレーンの外（Allure の reporter を足さないとき）は、`annotate` だけを残す

## 添付

```ts
attachFile(name: string, filePath: string): Promise<void>
attachContent(name: string, content: Uint8Array, extension: string): Promise<void>
attachText(name: string, text: string, extension: string): void
attachJson(name: string, value: unknown): void
attachJsonInTest(name: string, value: unknown): void
attachOutput(command: string, exitCode: number | string | undefined, stdout: string, stderr: string): void
readOutput(filePath: string): string
attachReadText(name: string, text: string): void
attachAtTestEnd(name: string, read: () => string): void
```

`attachFile` はファイルを読んで、`attachContent` は渡した中身を、そのまま Allure の添付にする。型は拡張子から決める。

`attachText`・`attachJson`・`attachOutput`・`readOutput`・`attachReadText`・`attachAtTestEnd` は、出力の添付（FR-007c）に使う。`attachAtTestEnd` は、テストが後から読む出力（注入した stream）を、テストの終わりの中身で添付する。allure-vitest の runtime は添付を同期で送るので、待たずに呼べる。

`attachJsonInTest` は、動いているテストの中でだけ添付する。`beforeAll` の添付は describe のテストごとに複製されるので、MCP のクライアントは `tools/list` の結果をこれで添付する。

| 拡張子 | 型 |
|---|---|
| `.png` | `image/png` |
| `.svg` | `image/svg+xml` |
| `.pdf` | `application/pdf` |
| `.pptx` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `.txt` | `text/plain` |
| `.json` | `application/json` |
| `.md` | `text/markdown` |

- 置き場所は `libs/interface-spec/src/vitest/attach.ts`。pecot-visual の `tests/_helpers/attach.ts` は re-export する
- 表に無い拡張子は、拡張子を示して throw する。`attachFile` も、ファイルの有無より先に拡張子を確かめる
- `attachFile` は、ファイルが無いと何もしない。無いことは、テストの元の判定が示す
- nx のレーンの外（Allure の reporter を足さないとき）は、何もしない
- 中身は呼んだときに読んで渡す。テストが後で成果物を消しても、添付は残る
- `attachOutput` は、空でない stdout・stderr を `<コマンド>（終了コード N） stdout` の名前で添付する。両方空なら空の stdout を 1 つ添付する。コマンドは先頭の 200 字。終了コードが無ければ名前に書かない
- `readOutput` は UTF-8 で読み、ファイル名を名前にして添付してから中身を返す。`.txt`・`.json`・`.md`・`.svg` でない拡張子は `.txt` で添付する（`attachFile`・`attachContent` は表に無い拡張子で throw する）

pytest は `.githooks/tests/attach.py` を `sys.path.insert` で読む。

```python
run_attached(args, *, check=False, **kwargs) -> subprocess.CompletedProcess
attach_output(command: str, stdout, stderr, returncode: int | None) -> None
read_output(path) -> str
attach_json(name: str, value) -> None
```

- `run_attached` は `subprocess.run` と同じ引数で動かし、出力を添付してから結果を返す。`check=True` で終了コードが 0 でないときも、timeout のときも、添付してから例外を投げる
- `attach_json` は、大きな出力の一部だけで判定するテストが、判定に使った値だけを JSON で添付する
- 添付の型は、出力が TEXT、`read_output` の `.json` と `attach_json` が JSON。走っているテストの外（`PYTEST_CURRENT_TEST` が無い）と、allure-pytest を読めないときは何もしない

bats は `.githooks/scripts/test_report/bats/pecot-bats/load.bash` の 3 つの関数で添付する。`setup` で `bats_load_library pecot-bats` と読む。

```bash
run_attached [run の印…] <コマンド…>
read_output <ファイル>
attach_file <ファイル>
```

- `run_attached` は、bats の `run` で動かし、`$output`・`$stderr` を添付してから、`run` の終了コードを返す。`$output`・`$status`・`$stderr` は `run` と同じに残る
  - 名前は `<コマンド 200 字>（終了コード N） stdout`・`stderr`。空でないものを添付し、両方空なら空の stdout を 1 つ添付する
  - 既定の `run` は stderr を `$output` に入れるので、両方を含む出力が stdout の名前で添付される。分けるには `--separate-stderr` を渡す
- `read_output` は、中身を stdout に出し、ファイル名を名前にして添付する。`.txt`・`.json`・`.md`・`.svg` でない拡張子は `text/plain` にする。読めなければ 1 を返す。vitest の `readOutput` が throw して落とすのと同じく、読めないときに `@test` が落ちる形で使う
  - 出力で確かめるときは、`run read_output <ファイル>` の後に `assert_success` を置いてから、`assert_output`・`refute_output` で確かめる
  - 値として使うときは、`content="$(read_output <ファイル>)"` のように単独の代入で受けてから判定に渡す。コマンドの引数の中の `"$(read_output …)"` では、失敗が `@test` を落とさない
- `attach_file` は、中身を出さずに添付する。node などに読ませるファイルに使う。型は上の表（vitest の `attachFile` と同じ 8 つの拡張子）で決め、表に無い拡張子は 1 を返す。ファイルが無いと何もしない
- 名前と型は、vitest の `attachOutput`・`readOutput`・`attachFile` と同じ。同じ `@test` の中で同じパスは 1 回だけ添付する
- nx のレーンの外（`PECOT_BATS_ATTACHMENTS` が無いとき）と、`setup_file`・`teardown_file` の中では、何もしない。formatter は、`setup_file`・`teardown_file` の出力を `@test` の結果に入れない
- 受け渡しの形
  - `run.sh` が、bats に `PECOT_BATS_ATTACHMENTS`（ファイルごとの一時のディレクトリ）を渡す
  - 関数がそこへ `<uuid>-attachment<拡張子>` を書き、fd 3 に `# pecot-attachment: <ファイル名> <型> <名前>` を書く
  - formatter が、`@test` の結果の `attachments`（`{name, source, type}`）に入れる

## `test-report.yml`（テストを動かし、レポートを作る）

| 契機 | 側 | 条件 |
|---|---|---|
| `push`（main） | 開発版 | — |
| `workflow_dispatch`（入力 `side`: `release` か `dev`） | 入力の側 | main からだけ起動できる。コミットは受けない |
| `release.yml` の本番の land の後 | リリース版 | `release.yml` が `side=release` で起こす |

`pull_request` は契機にしない。

開発版（`push` と、`workflow_dispatch` の `side=dev`）は、main でテストを流し直さない。レーンの最新の結果（data-model.md）を寄せ集め、結果の無いレーンだけを流す（2026-11-26 に改め、2026-11-27 に #821 で材料の決め方を決めた）。

| job | すること |
|---|---|
| side | 側と ReportSources（data-model.md）を決める。リリース版は `release_sources.py`、開発版は `dev_sources.py resolve`。出力の `report` はレポートを作るか（開発版は常に作る）、`run_tests` は流すレーンがあるか。リリース版で、結果を出せるプラグインが無ければ、後の job を飛ばして成功で終える |
| tests | `run_tests` のときだけ動く。ReportSources の `runs` とレーンの matrix。そのコミットを取り出し、dev container で 1 つのレーンを動かす。テストが落ちても、結果のディレクトリと `source.json`（レーンと取り出したコミット）を artifact `allure-results-<slug>` に上げる |
| history-get | リリース版だけ。S3 から `release/history.jsonl` を取り、Allure が読めるかを確かめる。`state`（`found`・`absent`・`unreadable`）と、`found` のときの `etag` を出す。`unreadable` は job summary に警告を出す。`found` のときだけ、ファイルを artifact `test-report-history-in` に上げる。取れない・読めないときも成功で終えるが、`read_history` が読めない行のほかの理由で止まったら失敗する（#822） |
| report | 全レーンの結果を取り、ResultsCheck で確かめる。開発版は、`dev_sources.py fetch` で `latest` の結果を取り出して `tests` の結果と合わせ、履歴を読まずに作る。作った後で `dev_sources.py pack` で `lane-latest`・`lane-latest-index` を上げる。リリース版は、`test-report-history-in` の履歴を `--history` に渡す。`generate.py` でレポートを作り、artifact `test-report-<side>` に上げる |
| history-put | リリース版で、`report` が成功し、`history-get` の `state` が `unreadable` でないときだけ。`test-report-history-out` を S3 に戻す。`found` は `If-Match: <etag>`、`absent` は `If-None-Match: *` の条件付きの書き込みにする。条件で断られたら、job summary に出して失敗する（#822） |

- 読めなかった回に書き戻さないのは、空の履歴から作った 1 行で、S3 の前の回を消さないため
- 条件付きの書き込みは、古い run の `history-put` だけをやり直したときに、新しい履歴を古いもので上書きしないため

出力:

| 出力 | 中身 |
|---|---|
| artifact `test-report-<side>` | レポートのツリーの tar（`report.tar`。どの側も `history.jsonl` を入れない）、`report-sources.json`。`retention-days` は 7、`overwrite: true` |
| artifact `test-report-history-in`・`test-report-history-out` | リリース版だけ。S3 から取った履歴（`found` のときだけ）と、1 行足した後の履歴の `history.jsonl`。`retention-days` は 1（#822） |
| artifact `lane-latest`・`lane-latest-index` | 開発版だけ。data-model の LaneLatest の置き場所。`retention-days` は 90、`overwrite: true` |

失敗の条件:

- 結果を残さずに止まったレーンがある（ResultsCheck）
- `allure generate` が失敗した

テストが落ちただけでは失敗しない。レポートを作り、run は成功で終える。

権限は、`contents: read` だけにする。side と report の job は、ほかの run の artifact を読むために `actions: read` も持つ（2026-11-27 に #821 で足した）。

リリース版の履歴を S3 で読み書きする `history-get`・`history-put` だけは、OIDC のために `id-token: write` も持つ（2026-11-26 に改め、2026-11-27 に #822 で job を決めた）。公開サイト（`pages-store`）への書き込みの権限と secret は、どの job も持たない。

S3 の履歴への入り方（#822）:

- 2 つの job は、environment `test-report-history` を `deployment: false` で使う。デプロイ先は、種類が Branch の `main` だけ
- ロール `pecot-test-report-history-actions` の信頼の条件は、`aud` が `sts.amazonaws.com` で、`sub` が `<前置き>:environment:test-report-history` に完全一致すること
  - 前置きは、リポの OIDC の subject の設定の `sub_claim_prefix`（ID の形。`repo:pecotcraft@351183614/pecot@1445775113`）
  - environment を参照する job の `sub` は、契機によらずこの値になる。`main` 以外の ref の run は、environment のデプロイ先の決まりで job が止まり、ロールに入れない
  - PR で workflow を書き換えて environment を参照しても、PR の ref は `main` でないので同じく止まる
- ロールの許可は、`release/history.jsonl` の読み書きと、バケットの一覧だけ。一覧が無いと、ファイルが無いときも 403 になり、「初めて」と「入れない」を見分けられない
- ロールの ARN とバケットの名前は、environment の変数 `TEST_REPORT_HISTORY_ROLE_ARN`・`TEST_REPORT_HISTORY_BUCKET` に置く。構成は `.github/test-report-history/`

concurrency は `test-report-<side>` で、`cancel-in-progress: false`。動いている run は取り消さず、後から来た run は待つ。待っている run は、さらに新しい run が来ると置き換わる。

## `pages-deploy.yml`（変える所）

| 契機 | 変える所 |
|---|---|
| `workflow_run` | 対象に `test-report.yml` を足す |

verify（RunProvenance に足す決まり）:

| 確かめ | 受ける条件 |
|---|---|
| workflow のパス | `.github/workflows/pages-build.yml` か `.github/workflows/test-report.yml` |
| `test-report.yml` の run の event | `push` か `workflow_dispatch`。`pull_request` の run は捨てる |
| head | main の祖先。開発版は、保管中のレポートのコミットより古くない |
| 側 | `push` は開発版。`workflow_dispatch` は、上がっている `test-report-{dev,release}` の artifact が 1 つだけのとき、その側 |
| リリース版の材料 | artifact の `report-sources.json` が、タグと main から決め直した値と同じ |
| 中身 | SideCheck（`store.py` の確かめ。安全でないパスが無い・`index.html` がある）。どの側も、tar の直下に `history.jsonl` があれば捨てる（開発版は #821、リリース版は #822）。履歴の行の確かめは、`history-get` が S3 から取ったときに行う |

store:

- レポートを、その側の `test-report/` に置く。その側の定義書と、ほかの側は変えない
- 定義書の側を差し替えるときは、その側の `test-report/` を残す
- `test-report/` が無い側（リリース版と開発版）には、案内のページを置く
- `.pecot-store.json` の `reports` に、run の ID とコミットを書く。リリース版は `report-sources.json` も `sources` に書く
- 開発版のレポートは、run のコミットが保管中のレポートのコミット（`reports.dev.sha`）と同じか、その子孫のときだけ保管する。古い run は保管しない
- 大きさの知らせ（900 MB）は、レポートも数える

deploy と preview-status は変えない。

## `ci.yml`（変える所）

- tests の job の「Stage JUnit」「Upload JUnit」の step を消す。artifact `pages-junit-<slug>` は上げない
- レポートのレーンは、CI でも Allure の結果を残す
- 同じリポの PR とマージキューの run は、流したレーンの結果を artifact `allure-results-<slug>`（30 日）に上げ、開発版のレーンの最新の結果の材料にする。成功した job だけが上げる（2026-11-27 に #821 で決めた）
- マージキューの run の lanes の job は、そのコミットで変更が届いたレーンと、その結果を持つ run を `lane-sources`（30 日）に上げる。積のモードで省いたレーンは、`find-pr-ci-base.sh` が見つけた PR の run を指す
- workflow の env に、開発版の URL を `PECOT_REPORT_SITE_URL` で渡す。PR とマージキューの run の nx のキャッシュの hash をそろえるため、両方に同じ値を渡す

## サイト（`interface-spec:docs`）

| 環境変数 | 変える所 |
|---|---|
| `PECOT_SITE_SIDE`・`PECOT_SITE_PR` | 今のまま |
| `PECOT_SITE_REPORT_PLUGINS` | 新しく足す。リリース版で、レポートに入っているプラグインの名前（カンマ区切り）。`release_build.py` が渡す |
| `PECOT_SITE_RESULTS`・`PECOT_SITE_STRICT`・`PECOT_SITE_LANES` | 消す |

出すもの:

| 所 | 開発版 | リリース版 | PR 版・手元 |
|---|---|---|---|
| フッターの「テストレポート」のリンク | 出す | レポートに入るプラグインがあれば出す。入っていないプラグインの名前を添える | 出さない |
| 振る舞いの項目の「テスト」のリンク | 出す | そのプラグインがレポートに入っていれば出す | 出さない |
| 合否・状態の数・テストの表・`development/` | 出さない | 出さない | 出さない |
| `permalink.html` | 出す | 出す | 出す |

## 手元でレポートを作る

```bash
python3 .githooks/scripts/test_report/generate.py --local --output <出力のディレクトリ>
```

- 手元にある結果のディレクトリだけで作る。欠けたレーンの名前を出して続ける
- 結果のあるレーンが 1 つも無ければ、「結果のあるレーンが 1 つも無いので、レポートを作れません」で止まる（終了コード 1）
- 履歴は読まず、書かない（`--history`・`--sources` と一緒には使えない）

`--local` でも公開の run でも、`generate.py` はレーンの `environment.properties` を 1 つにまとめ、`allure generate` に最後の結果のディレクトリとして渡す（#817）。

- Allure は、渡した順に結果のディレクトリを読み、`environment.properties` を読むたびにメタデータを置き換える。まとめないと、最後のレーンの値しか残らない
- まとめに入れるのは、書いた全レーンで値が同じキーだけにする。値の違うキーは、名前を stderr に出して入れない
- まとめは `--output` の外の一時のディレクトリに書き、`allure generate` の後で消す。どのレーンもファイルを持たなければ渡さない
- どのキーも値が違うときは、コメントだけのファイルを渡し、メタデータを空にする。Allure は空のファイルを読み飛ばすので、レーンの値が残ってしまう

## レポートの失敗の分類

`allurerc.mjs` の `categories` に、次の順で規則を書く（#817）。どれも `epic`（プロジェクト）、重大度（`severity`）の順に分け、その下を失敗の文言で分ける。

| 順 | 名前 | id | 入るもの |
|---|---|---|---|
| 1 | 不安定なテスト | `flaky` | 不安定と判定された failed・broken |
| 2 | 製品の不具合 | `product-errors` | failed（確かめが期待と違う値を見た） |
| 3 | テストの不具合 | `test-errors` | broken（確かめの前に想定外の例外で止まった） |

- 2・3 がすべての failed・broken を取るので、Allure の既定の `Product errors`・`Test errors` には何も入らず、画面に出ない
- failed と broken の分け方は、各 reporter の判定のまま変えない

公開の run は `generate.py --sources <report-sources.json> --output <出力のディレクトリ> [--history <history.jsonl>]` と打つ。

- `--local` でないときは `--sources` が要る。結果が欠けたレーンや、結果のコミットが材料と違うレーンがあれば、レーンの名前を出して止まる（終了コード 1）
- リリース版の材料のレーンは、今の `report-lanes.json` でなく、`runs` の各コミットの `report-lanes.json` で確かめる（#889）。手順は data-model の ResultsCheck
- `--history` は、`--output` の中に置けない。読めない行があれば、警告を出して空の履歴で作る
- `--history` を渡すのは、リリース版の run だけ。開発版の run は渡さない（2026-11-26 に改めた）
