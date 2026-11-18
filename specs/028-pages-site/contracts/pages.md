# Contract: 公開サイトの URL と、公開の workflow の入出力

## 公開サイトの URL

公開元は `https://pecotcraft.github.io/pecot/`。中身は保管ブランチ `pages-store` の全体（data-model.md の StoreLayout）。

| 側 | URL | 消えるとき |
|---|---|---|
| リリース版 | `/pecot/` | 消えない。まだ無いときは案内のページ |
| 開発版 | `/pecot/dev/` | 消えない。まだ無いときは案内のページ |
| PR 版 | `/pecot/pr/<番号>/` | PR のマージ・クローズの後の保管 |

各側の中のページの相対パスは、`sphinx-build` の出力と同じ（例: `reference/index.html`、`_generated/pecot-workflow/issue-show.html`）。側をまたいでも、同じページは同じ相対パスにある。

## 版の帯（すべてのページ）

| 出すもの | 例 |
|---|---|
| 側の名前 | 「リリース版」「開発版」「PR #612」「手元」 |
| コミット | `abc1234`（GitHub のコミットのページへのリンク。手元はリンク無し）。リリース版では骨組みのコミット |
| プラグインの版 | `pecot-workflow 8.0.0 ・ pecot-visual 3.0.1 ・ pecot-tools 3.0.1`。リリース版では、各版にタグのコミット（先頭 7 文字）を添える |
| 合否を作った時刻 | `2026-11-17 05:12 UTC` |
| 実行へのリンク | 「この合否を作った実行」（作る run の URL。手元は出さない） |
| 側の行き来 | 「リリース版」「開発版」へのリンク。今の側は文字だけ |
| PR へのリンク | PR 版だけ。「PR #612 を開く」 |

## `pages-build.yml`（側を作る）

| 契機 | 入力 | 作る側 |
|---|---|---|
| `push`（`main`） | — | `dev`（その push のコミット） |
| `pull_request`（opened・synchronize・reopened）、head が同じリポ | — | `pr`（PR の番号。head のコミット） |
| `pull_request`（closed） | — | 作らない（`pages-deploy.yml` を起こすためだけに成功で終わる） |
| `workflow_dispatch` | `side`（`release`・`dev`）だけ。コミットは受けない | `dev` は `github.sha`（起動した run のコミット）。`release` は ReleaseSources（data-model.md） |

- `workflow_dispatch` では、side の job は `github.ref == 'refs/heads/main'` でなければ失敗する。main 以外のブランチや、`main` という名前のタグで起動された run は、側を作らない
- 開発版は、起動の後に main の HEAD を求め直さない。帯のコミットと `.pecot-store.json` を、run の `head_sha` とそろえるため

job:

| job | すること |
|---|---|
| side | 側とコミットを決める。リリース版では ReleaseSources を決め、タグのコミットが main の祖先でなければ失敗する |
| build | dev container を 1 回だけ立て、レーンを順に動かし（テストが落ちても次へ進む）、続けてサイトを作る |

リリース版の build:

開発版・PR 版と同じく 1 つの job で、次の順に作る。依存はコンテナを作ったときのコミットで 1 回だけ入るので、コミットを替えるたびに入れ直す。

1. プラグインごとに、そのタグのコミットを取り出し、依存を入れ直す。そのタグの `junit-lanes.json` にある、そのプラグインのレーンを動かす。JUnit は作業ツリーの外へ移す
2. `skeleton` のコミットを取り出し、依存を入れ直す。各 `plugins/<name>/` をそのタグの中身に差し替えてから、1 の JUnit を元の場所に戻す
3. サイトを作る。STRICT と `iface_junit` は、1 で各タグから集めたレーンの一覧で動かす。`conf.py` は、その一覧を `PECOT_SITE_LANES`（junit-lanes.json と同じ形の JSON）で受け取る（`skeleton` の `junit-lanes.json` は使わない）

- `PECOT_SITE_SHA` は `skeleton`、`PECOT_SITE_PLUGIN_COMMITS` は各タグのコミット
- 依存の入れ直しの分だけ、開発版・PR 版より時間がかかる（research R6）

出力:

| 出力 | 中身 |
|---|---|
| artifact `pages-side-<side>`（PR は `pages-side-pr-<番号>`） | 1 つの側の HTML のツリーの tar と、レーンごとの JUnit。リリース版は `release-sources.json` も入れる。`retention-days: 7` |
| job summary | 側・コミット・レーンごとの合否の数 |

失敗の条件:

- 合否のレーンのうち、JUnit を残さなかったものがある（テストが落ちただけなら失敗にしない）
- `sphinx-build -W` が警告を出した
- リリース版で、タグのコミットが main の祖先でない、または `skeleton` が決まらない

権限は `contents: read` だけ。書き込みの権限と secret は持たない。

concurrency は `pages-build-<side>-<PR の番号か ref>` で、`cancel-in-progress: true`（同じ側は後に起動したものだけを残す）。

## `pages-deploy.yml`（確かめて保管し、公開する）

| 契機 | 条件 |
|---|---|
| `workflow_run`（`pages-build.yml` の completed） | 既定のブランチの文脈で動く。受けた run を RunProvenance（data-model.md）で確かめる |
| `workflow_dispatch` | 入力なし。`pages-store` の今の中身を公開し直すだけ |

job と権限:

| job | 権限・environment | すること |
|---|---|---|
| verify | `contents: read`・`actions: read`・`pull-requests: read` | RunProvenance で側を決める。artifact を、確かめた run の ID と側から作った名前で取り、SideCheck（data-model.md）で確かめる。確かめた中身を、この run の artifact に上げる。中身は実行しない |
| store | `contents: read`。environment `pages-store` | deploy key で `pages-store` を取り、StoreLayout の決まりで差し替える。verify が出した開いている PR の一覧に無い `pr/<番号>/` を消し、側の間の行き来のリンクを確かめて push する |
| deploy | `contents: read`・`pages: write`・`id-token: write`（starter workflow の値）。environment `github-pages` | `pages-store` を `configure-pages` v6 → `upload-pages-artifact` v5 → `deploy-pages` v5 で公開する |
| preview-status | `statuses: write` | PR 版を保管したとき、PR の head のコミットに commit status を付ける |

- `actions: write` は、どの job にも持たせない
- verify の後の job は、verify が API から決めた値（側・PR の番号・head の SHA・開いている PR の番号の一覧）だけを使う
- 受けた run が RunProvenance に合わないときは、verify が理由を summary に書き、store に側を渡さない。closed の PR の run と、合わない run でも、store は閉じた PR の掃除をする
- store は、`pages-store` を書き換えて push したかを出力 `changed` にする。deploy は、`changed` が真のときと、`workflow_dispatch` のときだけ動く。`workflow_dispatch` では verify と store は動かない

concurrency:

| job | concurrency |
|---|---|
| store | `group: pages-store`・`cancel-in-progress: false`・`queue: max`（待っている保管を消さない） |
| deploy | `group: pages`・`cancel-in-progress: false`（starter workflow の値） |

- `queue` は actionlint 1.7.12 が知らない。`.github/actionlint.yaml` の除外は path ごとなので、`paths` に `.github/workflows/pages-deploy.yml` を足し、publish-npm.yml と同じ除外を付ける。#529（除外を消す Issue）の対象にも加える

commit status:

| 項目 | 値 |
|---|---|
| context | `pages / preview` |
| state | `success` |
| `target_url` | `https://pecotcraft.github.io/pecot/pr/<番号>/` |
| 付け先 | PR の今の head のコミット |

- `pages / preview` の context は、必須のチェックの名前と重ならない
- `pages / preview` を付けるのは、main の定義で動く preview-status の job だけ
- `GITHUB_TOKEN` で付けた status は、GitHub Actions に固定した必須のチェックを満たす（research R12）。そのため、上の 2 つを `.githooks/tests/test_pages_workflows.py` で固定する

job summary:

- 受けた run・側・コミット・採否と、捨てたときの理由
- 消した PR の側
- `pages-store` の大きさ。900 MB を超えたら警告

## 保管ブランチ・environment・ruleset

リポの管理者が設定する。エージェントは打つコマンドを示し、ユーザーが打つ。

| 対象 | 決まり |
|---|---|
| `pages-store` ブランチ | ruleset で作成・更新・削除を止める。bypass は `actor_type: DeployKey`・`bypass_mode: always` |
| deploy key | 書き込みのできる deploy key は、このリポに 1 本だけ置く。DeployKey の bypass は、リポのすべての deploy key に当たり、1 本に絞れないため |
| environment `pages-store` | secret に deploy key の秘密鍵を置く。デプロイ先は「Selected branches and tags」で、種類をブランチにした `main` だけ |
| environment `github-pages` | デプロイ先は、種類をブランチにした `main` だけ |
| リリースのタグ | ruleset で `*-v*` の作成・更新・削除を止める。bypass は PECOT_BOT の App（`actor_type: Integration`）だけ。`text-rules-v*` にも当たる |
| GitHub Pages | 公開元は「GitHub Actions」 |

- environment のデプロイ先の種類をタグにすると、`main` という名前のタグが通る。種類はブランチにする

## `release.yml` への追加

本番（`dry-run=false`）で、`release-land.sh` の land が成功した後に、App のトークンで `gh workflow run pages-build.yml -f side=release` を打つ。dry-run では打たない。

- App のトークンは、本番では既に `permission-actions: write` を持つ。release の job に権限を足さない
- land の後に打つのは、タグのコミットが main の祖先になるのが land の後だから

## 手元の作り方（`interface-spec:docs`）

- 今の target のまま使う。`PECOT_SITE_*` が無ければ、側は「手元」で、コミットは手元の HEAD
- `PECOT_SITE_STRICT=1` のときだけ、合否のレーンの JUnit が欠けたら失敗する。作る run はこれを付ける。手元の既定は付けない
