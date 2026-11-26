# Contracts: テストレポート

028 の [contracts/pages.md](../../028-pages-site/contracts/pages.md) に足す・変える決まりを書く。書いていない所は、028 のまま。

## URL

| 側 | レポート | 履歴 |
|---|---|---|
| リリース版 | `https://pecotcraft.github.io/pecot/test-report/` | S3 のバケットに置き、公開しない（#822） |
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

環境変数:

| 名前 | 渡す人 | 値 |
|---|---|---|
| `PECOT_REPORT_SITE_URL` | `test-report.yml`（リリース版と、結果の無いレーンを main で流す開発版）と、`ci.yml` のマージキューの run（開発版の URL。渡し方は #821） | 側の URL。渡さなければ `http://localhost:8000/`。末尾に `/` が無ければ足す |
| `PECOT_REPORT_HISTORY` | `generate.py` | `--history` を渡したときだけ、履歴のパス。Allure の設定（`allurerc.mjs`）が読む。`--history` を渡すのはリリース版だけ |

- 終了コード・カバレッジの閾値の判定は、今のまま
- `pecot-workflow:test-hooks` の 2 回目（`env -i`）の実行は、Allure の結果を残さない

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
```

- `run_attached` は `subprocess.run` と同じ引数で動かし、出力を添付してから結果を返す。`check=True` で終了コードが 0 でないときも、timeout のときも、添付してから例外を投げる
- 添付の型は、出力が TEXT、`read_output` の `.json` が JSON。走っているテストの外（`PYTEST_CURRENT_TEST` が無い）と、allure-pytest を読めないときは何もしない

## `test-report.yml`（テストを動かし、レポートを作る）

| 契機 | 側 | 条件 |
|---|---|---|
| `push`（main） | 開発版 | — |
| `workflow_dispatch`（入力 `side`: `release` か `dev`） | 入力の側 | main からだけ起動できる。コミットは受けない |
| `release.yml` の本番の land の後 | リリース版 | `release.yml` が `side=release` で起こす |

`pull_request` は契機にしない。

開発版（`push` と、`workflow_dispatch` の `side=dev`）は、main でテストを流し直さない。レーンの最新の結果（data-model.md）を寄せ集め、結果の無いレーンだけを流す（2026-11-26 に改めた。材料の決め方は #821）。

| job | すること |
|---|---|
| side | 側と ReportSources（data-model.md）を決める。リリース版で、結果を出せるプラグインが無ければ、後の job を飛ばして成功で終える。開発版は、結果の無いレーンだけを `runs` に入れる |
| tests | ReportSources の `runs` とレーンの matrix。そのコミットを取り出し、dev container で 1 つのレーンを動かす。テストが落ちても、結果のディレクトリと `source.json`（レーンと取り出したコミット）を artifact `allure-results-<slug>` に上げる |
| report | 全レーンの結果を取り、ResultsCheck で確かめる。開発版は、レーンの最新の結果と `tests` の結果を合わせ、履歴を読まずに作る。リリース版は、S3 から履歴を取る（取れないときは、空の履歴でレポートを作り、job summary に警告を出す）。`generate.py` でレポートを作り、artifact `test-report-<side>` に上げる |

出力:

| 出力 | 中身 |
|---|---|
| artifact `test-report-<side>` | レポートのツリーの tar（`report.tar`。リリース版は `history.jsonl` も入れる）、`report-sources.json`。`retention-days` は 7、`overwrite: true` |

失敗の条件:

- 結果を残さずに止まったレーンがある（ResultsCheck）
- `allure generate` が失敗した

テストが落ちただけでは失敗しない。レポートを作り、run は成功で終える。

権限は、`contents: read` だけにする。リリース版の履歴を S3 で読み書きする job だけは、OIDC のために `id-token: write` も持つ（2026-11-26 に改めた）。公開サイト（`pages-store`）への書き込みの権限と secret は、どの job も持たない。S3 に書く run と、ロールの信頼の条件は #822 で決める。

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
| 中身 | SideCheck（`store.py` の確かめ。安全でないパスが無い・`index.html` がある）。`history.jsonl` を行ごとに JSON として読む確かめは、リリース版の履歴を S3 に移すとき、#822 で扱いを決める |

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
- マージキューの run は、流したレーンの結果を artifact に上げ、開発版のレーンの最新の結果の材料にする（2026-11-26 に改めた。形は #821）
- マージキューが積のモードで省いたレーンは、PR の CI の run が試している。その結果をどう材料にするかは #821 で決める

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

公開の run は `generate.py --sources <report-sources.json> --output <出力のディレクトリ> [--history <history.jsonl>]` と打つ。

- `--local` でないときは `--sources` が要る。結果が欠けたレーンや、結果のコミットが材料と違うレーンがあれば、レーンの名前を出して止まる（終了コード 1）
- `--history` は、`--output` の中に置けない。読めない行があれば、警告を出して空の履歴で作る
- `--history` を渡すのは、リリース版の run だけ。開発版の run は渡さない（2026-11-26 に改めた）
