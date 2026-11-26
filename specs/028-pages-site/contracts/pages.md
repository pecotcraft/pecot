# Contract: 公開サイトの URL と、公開の workflow の入出力

## 公開サイトの URL

公開元は `https://pecotcraft.github.io/pecot/`。中身は保管ブランチ `pages-store` の全体（data-model.md の StoreLayout）。

| 側 | URL | 消えるとき |
|---|---|---|
| リリース版 | `/pecot/` | 消えない。まだ無いときは案内のページ |
| 開発版 | `/pecot/dev/` | 消えない。まだ無いときは案内のページ |
| PR 版 | `/pecot/pr/<番号>/` | PR のマージ・クローズの後の保管 |

各側の中のページの相対パスは、`sphinx-build` の出力と同じ（例: `reference/index.html`、`_generated/pecot-workflow/issue-show.html`）。側をまたいでも、同じページは同じ相対パスにある。

## 版の知らせ

Read the Docs の版の知らせと同じく、リリース版でない側でだけ、ページの上に 1 行の知らせを出す。コミット・プラグインの版・時刻・実行へのリンクは出さない（2026-11-18、#590 で帯から改めた）。

| 側 | 文 | リンク |
|---|---|---|
| 開発版 | 「これは開発中のバージョンのドキュメントです。」 | 「最新のリリース版を見る」（`/pecot/`） |
| PR 版 | 「これはプルリクエスト #612 のプレビューです。」 | 「プルリクエストを開く」・「最新のリリース版を見る」 |
| 手元 | 「これはローカルでビルドしたドキュメントです。」 | 無し |

## `pages-build.yml`（3 つの側を作る）

どの側も、テストを動かさず、テストの結果を待たずに作る（2026-11-18、#648 で改めた）。合否を出す env（`PECOT_SITE_RESULTS`・`PECOT_SITE_STRICT`）は渡さない。

| 契機 | 入力 | 作る側 |
|---|---|---|
| `push`（`main`） | — | `dev`（その push のコミット） |
| `pull_request`（opened・synchronize・reopened） | — | `pr`（PR の head のコミット）。head が同じリポの PR だけ。fork の PR では作らずに成功で終わる |
| `pull_request`（closed） | — | 作らない（`pages-deploy.yml` を起こし、閉じた PR を掃除させるためだけに成功で終わる） |
| `workflow_dispatch` | `side`（`release`・`dev`）だけ。コミットは受けない | `dev` は `github.sha`（起動した run のコミット）。`release` は ReleaseSources（data-model.md） |

- `workflow_dispatch` では、side の job は `github.ref == 'refs/heads/main'` でなければ失敗する。main 以外のブランチや、`main` という名前のタグで起動された run は、側を作らない
- 開発版は、起動の後に main の HEAD を求め直さない。作る中身と `.pecot-store.json` を、run の `head_sha` とそろえるため

job:

| job | すること |
|---|---|
| side | 側とコミットを決める。リリース版では ReleaseSources を決め、タグのコミットが main の祖先でなければ失敗する |
| build | dev container を立て、サイトを作る。PR 版は、merge のコミットでなく PR の head で作る |

リリース版の build:

開発版と同じく 1 つの job で、次の順に作る。

1. `skeleton` のコミットを取り出し、依存を入れ直す。各 `plugins/<name>/` をそのタグの中身に差し替える
2. サイトを作る。`conf.py` は、各タグから集めたレーンの一覧を `PECOT_SITE_LANES`（junit-lanes.json と同じ形の JSON）で受け取る（`skeleton` の `junit-lanes.json` は使わない）。この一覧が、サイトに載せるプラグインを決める
   - 2026-11-26 に 030（#699）で取り下げた。`PECOT_SITE_LANES` は無くなり、組み立てた作業ツリーで定義書を持つプラグインが載る

出力:

| 出力 | 中身 |
|---|---|
| artifact `pages-side-<side>`（PR 版は `pages-side-pr-<番号>`） | 1 つの側の HTML のツリーの tar。リリース版は `release-sources.json` も入れる。`retention-days` は 7、`overwrite: true` |

失敗の条件:

- `sphinx-build -W` が警告を出した
- リリース版で、タグのコミットが main の祖先でない、または `skeleton` が決まらない

権限は `contents: read` だけ。書き込みの権限と secret は持たない。

concurrency は `pages-build-<side>-<PR の番号か ref>` で、`cancel-in-progress: true`（同じ側は後に起動したものだけを残す）。

## `ci.yml`（サイトを作らない）

ci.yml は公開サイトを作らない。`pages-preview` の job は消した（2026-11-18、#648）。`pages-deploy.yml` は `workflow_run` で起きるので、ci.yml の中で PR 版を作ると、公開が ci の run の終わり（テストの終わり）を待つため。

tests の job が残すもの:

- 合否のレーン（`junit-lanes.json` にあるもの）の JUnit を、`$RUNNER_TEMP/pages-junit/<junit のパス>` に写して、artifact `pages-junit-<slug>` に上げる。同じリポの PR でだけ上げる
- 今は読む job が無い。テストレポートの載せ替え（#645）が使うか、片付ける
- この節は 2026-11-26 に 030（#699）で取り下げた。tests の job は JUnit の artifact を上げない
- 写すのは `Restore workspace owner` の後で、テストが落ちても写す（`if: always()`）
- upload の `path` はディレクトリにする。ファイルを渡すと、upload-artifact が共通の親を根にして階層を消すため
- `retention-days: 1`・`overwrite: true`

## `pages-deploy.yml`（確かめて保管し、公開する）

| 契機 | 条件 |
|---|---|
| `workflow_run`（`pages-build.yml` の completed） | 既定のブランチの文脈で動く。受けた run を RunProvenance（data-model.md）で確かめる |
| `workflow_dispatch` | 入力なし。`pages-store` の今の中身を公開し直すだけ |

job と権限:

| job | 権限・environment | すること |
|---|---|---|
| verify | `contents: read`・`actions: read`・`pull-requests: read` | RunProvenance で側を決める。artifact を、確かめた run の ID と側から作った名前で取り、SideCheck（data-model.md）で確かめる。確かめた中身を、この run の artifact に上げる。中身は実行しない |
| store | `contents: read`。environment `pages-store` | pages-store の App のトークンで `pages-store` を取り、StoreLayout の決まりで差し替える。verify が出した開いている PR の一覧に無い `pr/<番号>/` を消し、側の間の行き来のリンクを確かめて push する |
| upload | `contents: read`・`pages: read` | `pages-store` を取り、`configure-pages` v6 → `upload-pages-artifact` v5 で artifact `github-pages` に上げる |
| deploy | `contents: read`・`pages: write`・`id-token: write`（starter workflow の値）。environment `github-pages` | upload が上げた artifact を `deploy-pages` v5 で公開する |
| preview-status | `statuses: write` | PR 版を保管し、deploy が成功したか、`changed` が偽で deploy を飛ばしたとき、PR の head のコミットに commit status を付ける。開いたときに中身があるように、deploy の後に付ける |

- `actions: write` は、どの job にも持たせない
- verify の後の job は、verify が API から決めた値（側・PR の番号・head の SHA・開いている PR の番号の一覧）だけを使う
- 受けた run が RunProvenance に合わないときは、verify が理由を summary に書き、store に側を渡さない。closed の PR の run と、合わない run でも、store は閉じた PR の掃除をする
- store は、`pages-store` を書き換えて push したかを出力 `changed` にする。upload は、`changed` が真のときと、`workflow_dispatch` のときだけ動く。`workflow_dispatch` では verify と store は動かない
- deploy は、upload が成功したときだけ動く。upload と deploy を 1 つの job にすると、上げた直後の artifact を `deploy-pages` の照会が見つけられないことがあるため、starter workflow と同じく分ける（2026-11-26、#804 で改めた。actions/deploy-pages#451）

concurrency:

| job | concurrency |
|---|---|
| store | `group: pages-store`・`cancel-in-progress: false`・`queue: max`（待っている保管を消さない） |
| upload | `group: pages`・`cancel-in-progress: false`（starter workflow の値）・`queue: max` |
| deploy | `group: pages`・`cancel-in-progress: false`（starter workflow の値）・`queue: max` |

- deploy の `queue: max` は、PR への push のたびに deploy が起きるため。既定の `queue: single` では、待っている deploy が後から来た deploy に取り消され、その PR 版の status が付かない
- upload も deploy と同じ group に入れる。deploy は自分の upload より後に並ぶので、公開の順は `pages-store` を取った順と同じになる
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
| `pages-store` ブランチ | ruleset で作成・更新・削除を止める。bypass は pages-store の App（`actor_type: Integration`）・`bypass_mode: always` だけ |
| pages-store の App | 権限は Contents: write だけ、Webhook なし、このリポにだけ入れる。リリースの App（PECOT_BOT）は使わない。PECOT_BOT は main とタグにも書けるため |
| environment `pages-store` | 変数 `PAGES_STORE_APP_CLIENT_ID` と secret `PAGES_STORE_APP_PRIVATE_KEY` を置く。デプロイ先は「Selected branches and tags」で、種類をブランチにした `main` だけ |
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
- 何も付けなければ、公開サイトと同じく定義書だけを作る。JUnit は読まない
- `PECOT_SITE_RESULTS=1` を付けると、合否とテストレポートのページ（`development/`）も作る。JUnit が欠けたレーンのプラグインは「未実行」になる
- `PECOT_SITE_RESULTS=1` と `PECOT_SITE_STRICT=1` を付けると、合否のレーンの JUnit が欠けたら失敗する
- 上の 2 つは 2026-11-26 に 030（#699）で取り下げた。`PECOT_SITE_RESULTS`・`PECOT_SITE_STRICT` は無くなり、手元でも定義書だけを作る
