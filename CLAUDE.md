敬語を使ってください。

## リポジトリ構成

Claude Code / GitHub Copilot CLI 向けプラグインの monorepo（nx workspace）。

| プラグイン | 役割 | nx project | test レーン（target） |
|---|---|---|---|
| `plugins/pecot-workflow` | Issue/PR/リリース運用のワークフロー管理 | `pecot-workflow` | `test-py` / `test-cli` / `test-hooks` / `test-skills` |
| `plugins/pecot-visual` | ビジュアル系スキル（Slidev / draw.io） | `pecot-visual` | `test-cli` / `test-bootstrap` / `test-slidev` / `test-hooks` / `test-compare` / `test-release` / `test-skills` |
| `plugins/pecot-tools` | 許可リストで限定した awscli コマンドの MCP サーバ | `pecot-tools` | `test-cli` / `test-bootstrap` / `test-release` |
| `libs/text-rules` | テキスト規則ライブラリ（pecot-visual への同梱と root フックが使う） | `text-rules` | `test-unit` |

1 プラグイン = 1 nx project（`libs/text-rules` も 1 project）。`test` target は `nx run-many -t test` で全量を実行する起点で、dependsOn でレーン `test-*` を束ねる。
入力を持たないため、`nx affected -t test` では何も選ばれず 0 件で成功する。
チェックはレーン名を列挙して `nx affected` で要求し、変更が届いたレーンだけを実行する。
install・build は毎回実行する。lint は pecot-visual と pecot-workflow が `lint-*` のレーンに分かれ、pecot-tools・text-rules は `lint` 1 つ

## プラグイン製品としての前提

- このリポジトリの成果物は配布物であり、利用環境のエージェントの挙動はこれらだけで決まる。
  成果物は、スキル指示文（各 `SKILL.md`）、テンプレート（`plugins/pecot-workflow/cli/templates/`）、CLI 検証である。
  利用環境は Claude Code / GitHub Copilot CLI を指す
- フロー生成文書（Issue / PR 本文・コメント）の品質問題はプラグインの製品欠陥として
  配布成果物の修正で解決する。エージェントメモリ・セッション内の心がけ・ローカル設定を
  解決手段にしない
- このリポジトリで Issue / PR / コメント本文を書くときは、aist-roadmap#119 を唯一の基準とする。食い違うときは aist-roadmap#119 に従う。
  GitHub が UI で表示する情報を本文に書かない。UI で表示する情報は、Files changed・sub-issue 表示・Development 欄である。
  読者の判断に使われる情報だけ残す

## テスト・lint の実行

- PR ごとに CI（`ci.yml`）が検証を担う。
  - `checks (lint)` と `checks (githooks)` を動かす
  - 変更が届いたレーンごとに `tests (<project>:<target>)` を動かす
  - 結果を `ci-result` にまとめる。`ci-result` と `version-plan` が、`main` の ruleset の必須チェックである
  - tests の job は、job 内の nx リモートキャッシュのサーバを持つ。同じ repo の同じ PR の run が、成功したレーンだけで上げた artifact を取り込む。fork の PR と、ほかの PR・ブランチの結果は取り込まない
- 手元で動かすのは、変更箇所に絞ったテストと、CI の失敗の再現だけにする。push 前にレーンの全量を手で動かさない。同じ結果を 2 回待つだけになる。
  - 絞り方は、vitest / pytest ならファイル・ケースを指定し、`*.test.sh` なら該当の 1 本を指定する
- CI の失敗は、次の順で再現する。
  - 最初に、落ちた job の Summary と artifact（`ci-logs-<part>`・`ci-logs-tests-<slug>`）を見て、落ちたレーンとテストを特定する
  - `git fetch origin main` を打つ。CI の head は PR の merge commit なので、main が進んでいれば取り込んでから打つ。範囲の base は `--from-ref` の値ではなく、origin/HEAD との merge-base で決まる
  - `pre-commit run` は staged でない変更を退避し、index の内容で動く。直しは `git add` してから再実行する
  - 1 レーンは `NX_SKIP_NX_CACHE=true PECOTV_E2E_CEILING_SCALE=3 pnpm exec nx run <project>:<target>` で動かす。`<project>:<target>` は job 名のものをそのまま使う。dependsOn と project.json の環境変数が、CI と同じに付く
  - 変更が届いたレーンをまとめて動かすには、次を打つ。`NX_SKIP_NX_CACHE` が無いと、前に通ったレーンが local-cache で成功に見える。この形では 1 レーンに絞れない

    ```
    NX_SKIP_NX_CACHE=true pre-commit run --hook-stage manual nx-affected-tests --from-ref origin/main --to-ref HEAD
    ```

  - `checks (lint)` は次の 2 本で再現する。CI は version plan の確認を動かさないので、2 本目は `SKIP` でそろえる

    ```
    pre-commit run --from-ref origin/main --to-ref HEAD
    SKIP=check-version-plan-required pre-commit run --hook-stage pre-push --from-ref origin/main --to-ref HEAD
    ```

  - `checks (githooks)` は、次で再現する

    ```
    pre-commit run --hook-stage manual githooks-tests --from-ref origin/main --to-ref HEAD
    ```

  - 落ちたテストが特定できたら、以降はそのテストだけを再実行する。`plugins/<plugin>/scripts/ci/run-tests.sh --scope=<scope>` の `<scope>` は、レーン名 `test-<scope>` に当たる。`text-rules`・`nx-release` には `run-tests.sh` が無い。

    ```
    plugins/pecot-workflow/scripts/ci/run-tests.sh --scope=<py|cli|hooks|skills>
    plugins/pecot-visual/scripts/ci/run-tests.sh --scope=<cli|bootstrap|slidev|hooks|release|compare|skills>
    plugins/pecot-tools/scripts/ci/run-tests.sh --scope=<cli|bootstrap|release>
    ```

- lint / test のチェックは nx affected ベースの root 共通フック各 1 本が、レーン名の列挙を `nx affected -t` で要求して発火する。詳細は `.githooks/README.md` R1
  - lint は pre-commit の `nx-affected-lint` で、staged ファイルを `--files` で渡す
  - test は manual の stage の `nx-affected-tests` を CI が動かす。pre-push では動かさない
  - 手で動かすコマンドは `.githooks/README.md` の「検証の置き場」にある
- GitHub Actions のワークフローは `.github/workflows/` の 8 本である。
  - `ci.yml`: PR と main への push で、変更が届いたレーンを devcontainer で検証する。`checks (lint)`・`checks (githooks)` と、レーンごとの `tests (<project>:<target>)` に分けて同時に動かし、`ci-result` にまとめる
    - PR と merge queue では `version-plan` の job も動かす
  - `dependabot-auto-merge.yml`: dependabot の minor・patch の PR に、リリースの App のトークンで auto-merge を入れる。必須チェックが通ると merge queue でマージされる
  - `dependabot-prs.yml`: 人の判断を待つ dependabot の PR を Tracker 1 件の一覧にそろえる。PR の変化を App の webhook で、時間で決まる理由を Scheduler で受けて起動し、cron は最後の補助である。専用の GitHub App のトークンを使い、変数 `DEPENDABOT_PRS_APP_CLIENT_ID` が空の間は動かない
  - `devcontainer-image.yml`: CI 用の devcontainer イメージを GHCR に載せる。tag は `.devcontainer/` の tree hash の `def-<tree>` と、main だけの `latest` である
  - `publish-npm.yml`: MCP サーバの tgz を npm へ publish する
  - `release.yml`: 人が手で起動し、`main` 上で `nx release` を動かす。案を出す `plan` の後、Environment `release` の承認を待ってから `main` へ push する
  - `runtime-lock.yml`: Dependabot の PR で、各 `runtime-lock.yaml` を root の lock から作り直す。同じブランチへ、リリースの App のトークンで push する
  - `security-alerts.yml`: main の security alert を Tracker 1 件の一覧にそろえる。alert の操作を App の webhook で、取りこぼしを Scheduler で受けて起動し、cron は最後の補助である。GitHub App のトークンを使い、変数 `SECURITY_APP_CLIENT_ID` が空の間は動かない
- commit の前の検証は pre-commit が、メッセージの検証は commit-msg が、手元で行う。CI も pre-commit の stage と、pre-push の stage（version plan の確認を除く）を動かす

## 作業ファイルの置き場所

作業中に生成する一時ファイル・evidence・スクラッチは `.pecot/work/<Issue番号>/` 配下に置く。
`.pecot/work/` 直下のディレクトリ名は Issue 番号の数字のみにする。
タスクに紐づかない作業は、先に Issue を起票する。
`/tmp/` 直下は使わない。ユーザーが明示指定した場合と、`find /tmp -name ...` 等の system 調査参照は除く。
`.pecot/tmp/` は CLI / hooks 専用で、人・エージェントはファイルを置かない。
各 worktree の `.pecot/work` は、base の `.pecot/work` へのシンボリックリンクにしている。
リンクをたどって作業ディレクトリの外に出る書き込みでは、auto mode が確認を出す。
そのため、`.claude/settings.json` の `additionalDirectories` に、base の `.pecot/work` の絶対パスを置いている。

## リリース・nx release group の規約

- 単一ブランチ（`main`）trunk-based 運用。リリースは `release.yml` を `gh workflow run release.yml --ref main` で起動して行う。手元で `nx release` を実行しない
  - `plan` の job が dry-run の案を Summary と artifact `release-plan` に出す
  - 承認は、ユーザーが GitHub の画面で Environment `release` に対して行う。エージェントは承認しない
  - 承認の後、`release` の job がリリースの App のトークンで `main` へ push する。`main` に直接 push できるのは、ruleset の bypass にあるこの App だけである
  - 手順と、失敗したときのやり直しは w-release スキルにある
- `nx.json` の `release.groups[].projects` には、各 project を 1 つずつ列挙する。
  列挙するのは `["pecot-workflow"]` / `["pecot-visual"]` / `["pecot-tools"]` / `["text-rules"]` の 4 件である。
  1 group に複数 project を入れると、CHANGELOG が commit から脱落する（#624、nrwl/nx#35559）
- version-plan の frontmatter の bump 宣言キーは group 名のみにする。
  group 名は `pecot-workflow` / `pecot-visual` / `pecot-tools` / `text-rules` である
- ブランチモードは config の `develop_branch` と `release_branch` の異同で決まる。
  同じなら単一ブランチである。`develop-aist` を継続する他リポがあるため、shared hook の
  `develop-aist` ハードコードは温存する

## 環境の既知事項

- `base/pecot` のみ `.pnpm-store/`（1.6 GB 前後）が project 内に生成される。
  原因は devcontainer の bind mount による filesystem 非対称である。
  pnpm は store と install 先を同一 filesystem に要求する仕様なので、フォールバックとして生成される。
  gitignore 済み・正常
- 自分が起動されたディレクトリの外の worktree を操作しない。
  base で起動された場合はブランチ作業も base 上で行い、完了後に main へ戻す
- pecot-visual の lint 結果が同一ソースで揺れた場合は、キャッシュ汚染を原因と決める前に、決定論化規約を守っているか確認する。
  確認する対象は次の 3 点である。

  ```
  plugins/pecot-visual/assets/slidev/package.json: eslint --no-cache
  plugins/pecot-visual/assets/slidev/scripts/eslint/_shared/package.json: exports の型解決固定
  各サブパッケージの tsconfig: references によるビルド順
  ```

- devcontainer には awscli 2.39.4 が常備されている。
  `plugins/pecot-tools` の実 awscli テスト（`cli/tests/integration/real-awscli.test.ts`）はこの版で動く。
  偽 awscli の fixture と出典のコメントは、2.36.40 の実物から採ったものである。
  `grep -rn 2.36.40 plugins/pecot-tools` で当たる。
  版を上げるときは、次の 2 つを同じ変更で更新し、実 awscli テストを実行する。
  - この項の版
  - `.devcontainer/devcontainer.json` の `aws-cli` feature の `version`

  実 awscli テストが落ちたら、`plugins/pecot-tools/cli/src/domain`・`cli/src/infra` の該当箇所を直す。
  あわせて fixture を新しい版から採り直し、出典の版と採取日を書き換える。
  採り方は `cli/tests/_fixtures/fake-aws/fixtures/README.md` の「採取手順」にある。
  SSO のデバイス認証（`aws sso login --no-browser --use-device-code`）の出力と挙動は、実 awscli テストの対象外である。
  SSO 認証できる端末を使い、手で確かめる。
- pecot-visual / pecot-tools は、Node.js の脆弱性修正版より古い版では起動しない。
  下限は `plugins/pecot-visual/cli/src/node-runtime.ts` の表にある。devcontainer の Node.js も同じ版に固定する。
  更新前から動いている Claude Code・MCP サーバ・端末は古い Node.js のままなので開き直す。
  Node.js のセキュリティリリースで下限を上げるときは、次の 2 つを同じ変更で更新する。
  - `grep -rn <旧下限> plugins .githooks .github` で当たる箇所
  - `.devcontainer/devcontainer.json` の `node` feature の `version`
- devcontainer の Claude Code は、`.devcontainer/Dockerfile` でネイティブ版を vscode ユーザーの持ち物で入れている。
  セッション中の自動更新で最新に保つ。`npm install -g` や devcontainer の feature で入れ直さない。
  root の持ち物になり、自動更新が権限で止まる。
