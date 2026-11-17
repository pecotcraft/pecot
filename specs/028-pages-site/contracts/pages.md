# Contract: 公開サイトの URL と、公開の workflow の入出力

## 公開サイトの URL

公開元は `https://pecotcraft.github.io/pecot/`。

| 側 | URL | 消えるとき |
|---|---|---|
| リリース版 | `/pecot/` | 消えない |
| 開発版 | `/pecot/dev/` | 消えない |
| PR 版 | `/pecot/pr/<番号>/` | PR のマージ・クローズの後の公開 |

各側の中のページの相対パスは、`sphinx-build` の出力と同じ（例: `reference/index.html`、`_generated/pecot-workflow/issue-show.html`）。側をまたいでも、同じページは同じ相対パスにある。

## 版の帯（すべてのページ）

| 出すもの | 例 |
|---|---|
| 側の名前 | 「リリース版」「開発版」「PR #612」「手元」 |
| コミット | `abc1234`（GitHub のコミットのページへのリンク。手元はリンク無し） |
| プラグインの版 | `pecot-workflow 8.0.0 ・ pecot-visual 3.0.1 ・ pecot-tools 3.0.1` |
| 合否を作った時刻 | `2026-11-17 05:12 UTC` |
| 実行へのリンク | 「この合否を作った実行」（作る run の URL。手元は出さない） |
| 側の行き来 | 「リリース版」「開発版」へのリンク。今の側は文字だけ |
| PR へのリンク | PR 版だけ。「PR #612 を開く」 |

## `pages-build.yml`（側を作る）

| 契機 | 入力 | 作る側 |
|---|---|---|
| `push`（`main`） | — | `dev` |
| `pull_request`（opened・synchronize・reopened）、head が同じリポ | — | `pr`（PR の番号） |
| `pull_request`（closed） | — | 作らない（`pages-deploy.yml` を起こすためだけに成功で終わる） |
| `workflow_dispatch` | `side`（`release` / `dev`） | 指定の側。コミットは、`release` が GitHub の Latest のリリースのタグが指すコミット、`dev` が既定のブランチの先頭 |

出力:

| 出力 | 中身 |
|---|---|
| artifact `pages-side-<side>`（PR は `pages-side-pr-<番号>`） | 1 つの側の HTML のツリーの tar。`retention-days: 90` |
| artifact `pages-junit-<slug>` | 合否のレーンごとの JUnit。調べ直し用 |
| job summary | 側・コミット・レーンごとの合否の数 |

失敗の条件:

- 合否のレーンのうち、JUnit を残さなかったものがある（テストが落ちただけなら失敗にしない）
- `sphinx-build -W` が警告を出した

権限は `contents: read` だけ。

手での起動は、作るコミットを入力で受け取らない。既定のブランチの権限で、入力のコミットのコードを動かさないためだ（CodeQL の `actions/cache-poisoning/poisonable-step`）。

concurrency は `pages-build-<side>-<PR の番号か ref>` で、`cancel-in-progress: true`（同じ側は後に起動したものだけを残す）。

## `pages-deploy.yml`（組み立てて公開する）

| 契機 | 条件 |
|---|---|
| `workflow_run`（`pages-build.yml` の completed） | 既定のブランチの文脈で動く。作る run が失敗でも動き、残っている artifact で組み立て直す |
| `workflow_dispatch` | 入力なし。今ある artifact で組み立て直す |

権限:

| job | 権限 |
|---|---|
| 組み立て | `contents: read`、`actions: write`（別の run の artifact の取得と、リリース版を作る run の起動）、`pull-requests: read`（開いている PR）、`statuses: write`（PR 版のリンク） |
| 公開 | `pages: write`、`id-token: write` |

environment は `github-pages`（既定のブランチだけが deploy できる保護）。concurrency は `group: pages`、`cancel-in-progress: false`。

出力:

| 出力 | 中身 |
|---|---|
| GitHub Pages の公開 | 組み立てたツリー全体 |
| commit status | PR 版のある PR の head のコミットに、context `pages / preview`、state `success`、`target_url` に PR 版の URL |
| job summary | 側ごとの採否（使った run・コミット・外した理由）と、ツリーの大きさ |

リリース版の artifact が見つからないとき:

1. 公開しない（job は失敗）
2. 最新のリリースのコミット（GitHub の Latest のリリースのタグが指すコミット）について、`side=release` の作る run を探す
3. その SHA の作る run が進行中か、最後のものが失敗なら、起こさずに summary に書いて終わる（作り直しのループを止める）
4. どちらでもなければ、`pages-build.yml` を `side=release` で起こす（作る run が、同じ Latest のリリースのコミットを選ぶ）
5. その完了で、`pages-deploy.yml` がもう一度動く

## `release.yml` への追加

本番（`dry-run=false`）が成功したら、最後の段で `gh workflow run pages-build.yml -f side=release` を打つ。dry-run では打たない。この段の job には `actions: write` を付ける。

## 手元の作り方（`interface-spec:docs`）

- 今の target のまま使う。`PECOT_SITE_*` が無ければ、側は「手元」で、コミットは手元の HEAD
- `PECOT_SITE_STRICT=1` のときだけ、合否のレーンの JUnit が欠けたら失敗する。作る run はこれを付ける。手元の既定は付けない
