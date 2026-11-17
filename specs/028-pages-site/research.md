# Research: pecot の文書サイトを GitHub Pages で公開する

公式の仕様は、公式リポ（actions/deploy-pages v5・actions/upload-pages-artifact v5・actions/configure-pages・actions/download-artifact v8・actions/starter-workflows）と docs.github.com で確かめた。

## R1. 公開元と公開の形

- **Decision**: 公開元は「GitHub Actions」。
  `configure-pages` → `upload-pages-artifact` → `deploy-pages` の公式の 3 段で公開する。
  environment は `github-pages` とし、既定のブランチだけが deploy できる保護を付ける。
  concurrency は `group: pages`・`cancel-in-progress: false`（starter workflow の値）
- **Rationale**: docs は、Jekyll 以外でビルドするときは Actions を推奨する（"If you want to use a build process other than Jekyll … we recommend that you write a GitHub Actions workflow"、configuring-a-publishing-source）。
  保護と concurrency の値は docs と starter-workflows の `pages/static.yml` の推奨そのもの
- **Alternatives considered**:
  - 公開元「Deploy from a branch」（gh-pages）: 公式にサポートされた形で、サブディレクトリの足し引きで部分更新できる。ただし Sphinx でビルドする形に docs が推奨するのは Actions。PR ごとのサブディレクトリを置く公式の手順は無く、第三者の action（rossjrw/pr-preview-action）頼みになる
  - `deploy-pages` の `preview` 入力: action.yml に "only in alpha currently and is not available to the public" とあり、前提にできない

## R2. 3 つの側を 1 つのサイトに並べる方法

- **Decision**: 側ごとに「作る run」と、全体を「組み立てて公開する run」を分ける
  - 作る run（`pages-build.yml`）: 1 つの側のサイトを作り、`pages-side-<side>` の名前の artifact に上げる。公開はしない
  - 公開する run（`pages-deploy.yml`）: 既定のブランチの文脈で動く。今ある側の artifact（最新のリリース版・最新の開発版・開いている PR の PR 版）をすべて集めて 1 つのツリーに組み、公開する
- **Rationale**: REST の Create a GitHub Pages deployment は artifact を 1 つ受け取り、配置先の path を持たない。upload-pages-artifact は単一の tar。deploy-pages は同じ run の artifact しか探さない。よって 1 回の deploy はサイト全体を差し替える。ほかの側を消さない（FR-020）には、毎回すべての側を集め直すしかない
- **Alternatives considered**:
  - 毎回すべての側を作り直す: 側の数だけ合否のレーンを動かすことになり、PR が増えると 30 分（SC-005・SC-007）に収まらない
  - 公開中のサイトを URL から取り込んで差分だけ足す: 公開物を正にすることになり、壊れた公開が次へ引き継がれる

## R3. PR 版を作る run の権限と信頼の境界

- **Decision**: PR 版は `pull_request`（同じリポのブランチだけ）の run で作り、artifact に上げるだけにする。公開は `workflow_run`（作る run の完了）で起きる `pages-deploy.yml` が行う。公開する run は、artifact を「静的なファイルの束」としてだけ扱い、中身を実行しない
- **Rationale**:
  - fork の `pull_request` では write の権限がすべて read only になり、`pages: write` が付かない（workflow-syntax#permissions）。同じリポのブランチに限る判定は、ci.yml の `head.repo.full_name == github.repository` と同じ形にする
  - PR の run から deploy するには、environment の保護に `refs/pull/*/merge` を足す必要があり、docs の推奨（既定のブランチだけ）から外れる
  - `pull_request_target` は使わない。docs は「PR のコードをビルド・実行するなら避けよ」とし、public リポでは 2026-12-02 から既定のポリシーで止まる
  - docs は、`workflow_run` で PR の artifact を扱うとき、中身を untrusted なデータとして扱うよう求める。公開する run は tar を展開して所定のディレクトリに置くだけにし、パスがそのディレクトリの外へ出るものは止める
- **Alternatives considered**: PR の run から直接公開する（R1 の保護を緩める）。不適合になるので採らない

## R4. 各側の artifact の保管と期限切れ

- **Decision**: 作る run の artifact は `retention-days: 90`（public リポの上限）で残す。
  公開する run は、各側について「最後に成功した作る run」の artifact を探す。
  リリース版の artifact が見つからない（期限切れ）ときは、公開せずに失敗する。
  そのうえで、最新のリリースのコミットで作る run を `workflow_dispatch` で起こし、その完了で公開をやり直す
- **Rationale**: 公開の流れの正を「作る run の artifact」に置けば、新しい保管場所（ブランチ・Release の asset）が要らない。開発版と PR 版は 90 日以内に必ず作り直される。リリースが 90 日以上空いたときだけ、自動で作り直せばよい
- **Alternatives considered**:
  - 専用ブランチに tar を commit する: docs が Actions 方式で避けるとする「ビルド物を置く専用ブランチ」と同じ形になる
  - Release の asset に置く: リリースはプラグインごとに分かれ、どのリリースに付けるかが決まらない

## R5. どの run が何を起こすか

- **Decision**:

  | 契機 | 作る run（`pages-build.yml`） | 公開する run（`pages-deploy.yml`） |
  |---|---|---|
  | main への push | 開発版を作る | 作る run の完了の `workflow_run` で起きる |
  | `release.yml` の本番が済む | release.yml の最後の段が `gh workflow run pages-build.yml -f side=release -f sha=<SHA>` で起こす | 同上 |
  | 同じリポの PR の opened・synchronize・reopened | PR 版を作る | 同上 |
  | 同じリポの PR の closed | 作らずに終わる | 同上。開いている PR を数え直し、閉じた PR の側を外す |
  | 手での起動 | `workflow_dispatch`（side と sha を指定） | 同上。公開だけのやり直しは `pages-deploy.yml` の `workflow_dispatch` |

- **Rationale**: `GITHUB_TOKEN` で起こした run は、新しい workflow を起こさない。ただし `workflow_dispatch` と `repository_dispatch` は例外として起こす（docs: triggering-a-workflow-from-a-workflow）。release.yml から作る run を起こすのは、この例外に当たる
- **Alternatives considered**: `pages-build.yml` が release.yml の `workflow_run` を受ける。本番か dry-run かと SHA を、run の入力から読み直すことになり、手での起動と入口がそろわない

## R6. 合否のレーンを動かす方法

- **Decision**: 作る run は、合否のレーンごとに matrix の job を立てる。
  各 job は、ci.yml と同じ dev container（`.githooks/ci/dev-container.sh`）で `nx run <project>:<target>` を動かす。
  テストが落ちても job は止めず、JUnit を artifact に上げる。
  JUnit が無いレーンが 1 つでもあれば、サイトを作る job は失敗する
- **Rationale**: PR の CI と同じ環境で動かせば、手元・CI・公開で合否がずれない。今のレーンは 2〜7 分で終わり、並べて動かせば 30 分に収まる
- **Alternatives considered**: PR の CI の JUnit を流用する。affected のレーンしかそろわないので、spec の FR-003 に反する

## R7. 合否のレーンの定め

- **Decision**: 合否のレーンと JUnit のパスを `libs/interface-spec/docs/junit-lanes.json` の 1 か所に書く。`conf.py` の `iface_junit` と、作る run の matrix は、どちらもこのファイルから決める
- **Rationale**: FR-009。今の `iface_junit` は `conf.py` に直書きで、pecot-workflow の `junit.xml` が 2 回書かれている。workflow が別に一覧を持つと、レーンを足したときにずれる
- **Alternatives considered**: `project.json` の `outputs` から JUnit を拾う。pecot-visual の `test-hooks` のように、JUnit を出さないレーンがあり、どれが合否のレーンかを決められない

## R8. 版と実行の表示

- **Decision**: サイトを作るときに、環境変数（`PECOT_SITE_SIDE`・`PECOT_SITE_SHA`・`PECOT_SITE_RUN_URL`・`PECOT_SITE_BUILT_AT`・`PECOT_SITE_PR`）を `conf.py` が読み、`html_context` に渡す。
  テンプレートの `header.html` が、すべてのページの上に版の帯を出す。
  各プラグインの版は、各プラグインの `package.json` の `version` から読む。
  手元では、環境変数が無ければ `git rev-parse` と今の時刻で埋め、側を「手元」と出す
- **Rationale**: FR-012・FR-013・FR-019・FR-021・FR-025。テーマの既存のテンプレート（`_templates/header.html`）を使えば、全ページに 1 か所で出せる
- **Alternatives considered**: 版の情報をトップだけに出す。SC-004（どのページからも 1 クリック）を満たさない

## R9. 状態の 5 つの区別

- **Decision**: `outcome_of` を、通った・落ちた・飛ばした・テストが無い・未実行の 5 つにする。決め方は data-model.md の「振る舞いの状態」
- **Rationale**: FR-014。今は、飛ばしたケースを含む項目と、つながるケースが無い項目を、どちらも「未実行」にしている。spec はこの 2 つを未実行と分ける
- **Alternatives considered**: 飛ばしたものを「通った」に含める。確かめていない項目を通ったと出すことになる

## R10. PR から PR 版へのリンク

- **Decision**: 公開する run が、PR の head のコミットに commit status（context `pages / preview`、`target_url` に PR 版の URL）を付ける
- **Rationale**: FR-023。PR の checks の欄から 1 クリックで開ける。PR の本文やコメントを増やさない（CLAUDE.md の「GitHub が UI で出す情報を本文に書かない」とそろう）。status は head のコミットに付くので、push のたびに新しいコミットへ付け直される
- **Alternatives considered**: PR にコメントを付けて更新する。PR の会話に機械の書き込みが増える

## R11. リンク切れ

- **Decision**: サイトは今の `sphinx-build -W`（警告を失敗にする）で作る。組み立ての後に、組んだツリーの内部リンク（側の間の行き来を含む）を確かめる段を置く。外部リンクは確かめない
- **Rationale**: FR-019・SC-006。Sphinx の参照切れは `-W` で止まる。側の行き来のリンクは Sphinx の外で決まるので、組み立ての後に確かめる
- **Alternatives considered**: `sphinx-build -b linkcheck` で外部も確かめる。外部のサイトの都合で公開が止まる
