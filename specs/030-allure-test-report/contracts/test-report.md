# Contracts: テストレポート

028 の [contracts/pages.md](../../028-pages-site/contracts/pages.md) に足す・変える決まりを書く。書いていない所は、028 のまま。

## URL

| 側 | レポート | 履歴 |
|---|---|---|
| リリース版 | `https://pecotcraft.github.io/pecot/test-report/` | `…/test-report/history.jsonl` |
| 開発版 | `https://pecotcraft.github.io/pecot/dev/test-report/` | `…/dev/test-report/history.jsonl` |
| PR 版 | 無い | 無い |

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
| `PECOT_REPORT_SITE_URL` | `test-report.yml` | 側の URL。渡さなければ `http://localhost:8000/` |

- 終了コード・カバレッジの閾値の判定は、今のまま
- `pecot-workflow:test-hooks` の 2 回目（`env -i`）の実行は、Allure の結果を残さない

## `verifies`

```ts
verifies(context: TestContext, id: string): Promise<void>
```

| 残すもの | 形 |
|---|---|
| vitest の annotation | `context.annotate(id, 'verifies')`（今のまま。JUnit の `<property name="verifies">` になる） |
| Allure のリンク | 型 `tms`、名前は `id`、URL は `<PECOT_REPORT_SITE_URL>permalink.html?id=<id>` |
| Allure の tag | `id` |

- 置き場所は `libs/interface-spec/src/vitest/verifies.ts`。各プラグインの `tests/_helpers/verifies.ts` は re-export する
- 呼び方は変えない

## `test-report.yml`（テストを動かし、レポートを作る）

| 契機 | 側 | 条件 |
|---|---|---|
| `push`（main） | 開発版 | — |
| `workflow_dispatch`（入力 `side`: `release` か `dev`） | 入力の側 | main からだけ起動できる。コミットは受けない |
| `release.yml` の本番の land の後 | リリース版 | `release.yml` が `side=release` で起こす |

`pull_request` は契機にしない。

| job | すること |
|---|---|
| side | 側と ReportSources（data-model.md）を決める。リリース版で、結果を出せるプラグインが無ければ、後の job を飛ばして成功で終える |
| tests | ReportSources の `runs` とレーンの matrix。そのコミットを取り出し、dev container で 1 つのレーンを動かす。テストが落ちても、結果のディレクトリと `source.json`（レーンと取り出したコミット）を artifact `allure-results-<slug>` に上げる |
| report | 全レーンの artifact を取り、ResultsCheck で確かめる。公開中の履歴を取る。`generate.py` でレポートを作り、レポートと履歴と `report-sources.json` を artifact `test-report-<side>` に上げる |

出力:

| 出力 | 中身 |
|---|---|
| artifact `test-report-<side>` | レポートのツリーと `history.jsonl` の tar、`report-sources.json`。`retention-days` は 7、`overwrite: true` |

失敗の条件:

- 結果を残さずに止まったレーンがある（ResultsCheck）
- `allure generate` が失敗した

テストが落ちただけでは失敗しない。レポートを作り、run は成功で終える。

権限は、どの job も `contents: read` だけ。書き込みの権限と secret は持たない。

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
| 中身 | SideCheck（`store.py` の確かめ。安全でないパスが無い・`index.html` がある・`history.jsonl` が行ごとに JSON として読める） |

store:

- レポートを、その側の `test-report/` に置く。その側の定義書と、ほかの側は変えない
- 定義書の側を差し替えるときは、その側の `test-report/` を残す
- `test-report/` が無い側（リリース版と開発版）には、案内のページを置く
- `.pecot-store.json` の `reports` に、run の ID とコミットを書く
- 大きさの知らせ（900 MB）は、レポートも数える

deploy と preview-status は変えない。

## `ci.yml`（変える所）

- tests の job の「Stage JUnit」「Upload JUnit」の step を消す。artifact `pages-junit-<slug>` は上げない
- レポートのレーンは、CI でも Allure の結果を残す。CI は、それを artifact に上げない

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
- 履歴は読まず、書かない
