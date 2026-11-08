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

- テストの全量は pre-push のチェック（下記）が実行する。push 前に同じ全量を手で実行しない。
  同じ結果を 2 回待つだけになる。手で実行するのは変更箇所に絞ったテストだけにする。
  絞り方は、vitest / pytest ならファイル・ケースを指定し、`*.test.sh` なら該当の 1 本を指定する。
- 各プラグインの `scripts/ci/run-tests.sh` を lane 単位で手動実行するのは、チェックの失敗を
  再現するときだけ。落ちたテストが特定できたら、以降はそのテストだけを再実行する。コマンドは次のとおり。

  ```
  plugins/pecot-workflow/scripts/ci/run-tests.sh --scope=<py|cli|hooks|skills|all>
  plugins/pecot-visual/scripts/ci/run-tests.sh --scope=<cli|bootstrap|slidev|hooks|release|compare|skills|all>
  plugins/pecot-tools/scripts/ci/run-tests.sh --scope=<cli|bootstrap|release|all>
  ```

- lint / test のチェックは nx affected ベースの root 共通フック各 1 本が、
  レーン名の列挙を `nx affected -t` で要求して発火する。詳細は `.githooks/README.md` R1
  - lint は pre-commit の `nx-affected-lint` で、staged ファイルを `--files` で渡す。
  - test は pre-push の `nx-affected-tests` で評価する。範囲は version-plan ガードと同一の base/head 解決（`lib/push-range.sh`）による push range
- GitHub Actions のワークフローは `.github/workflows/` の 5 本である。
  - `ci.yml`: PR と main への push で、変更が届いたレーンを devcontainer で検証する。lint・githooks の 2 job と、変更が届いたレーンごとの tests の job に分けて同時に動かす
  - `devcontainer-image.yml`: CI 用の devcontainer イメージを GHCR に載せる
  - `publish-npm.yml`: MCP サーバの tgz を npm へ publish する
  - `runtime-lock.yml`: Dependabot の PR で、各 `runtime-lock.yaml` を root の lock から作り直し、同じブランチへ push する
  - `security-alerts.yml`: main の security alert を毎時 Tracker 1 件の一覧にそろえる。GitHub App のトークンを使い、変数 `SECURITY_APP_CLIENT_ID` が空の間は動かない
- commit 時の品質は、今までどおり author ローカル env で pre-commit が pass したことに依拠する

## ブランドの語の確認

このリポジトリと配布物には、特定の組織のブランドの語（名前・色・書体など）を置かない。
語の一覧は本体の外にあり、`check-brand-terms.sh`（`.githooks/pre-commit/`）が一覧を読んで確かめる。
開発者は、一覧の写しをリポジトリの外の手元に置き、その絶対パスを環境変数 `PECOT_BRAND_TERMS_FILE` に渡す。
端末の起動時に読まれる設定（shell の rc ファイルなど）に書いておく。

```
export PECOT_BRAND_TERMS_FILE=<brand-terms.txt の絶対パス>
```

- pre-push の `check-brand-terms` は、push するコミットの中身とパスの名前を調べる。
  一致があれば、ファイルと語を表示して止める。`PECOT_BRAND_TERMS_FILE` が無ければ、飛ばしたことを表示して通す
- リリースは、`audit-mcp-dist.sh` が version より前に一覧の有無を確かめる。無ければ止まる。単体配布の公開は、配布ツリーの全ファイルを調べる
- 一覧は 1 行 1 件の固定文字列で、大文字小文字を区別する。`#` の直後が空白か行末の行は注釈。`#abcdef` のような色の行は語として読む
- `CHANGELOG.md` は対象から除く
- 手元で確かめるには、`.githooks/pre-commit/check-brand-terms.sh --ref HEAD` を実行する。作業ツリーのディレクトリは `--dir <path>` で調べる
- 新しく付ける識別子・ファイル名・文言・テストの値に、一覧の語を書かない。テストの語は合成した値にする

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

- 単一ブランチ（`main`）trunk-based 運用。リリースは `base/pecot` の `main` 上で
  `pnpm exec nx release` を実行する。詳細は w-release スキルにある。
  どの worktree で起動したセッションでも base に移動して実行し、実行場所をユーザーに確認しない。
  base で行うのは w-release の手順のコマンドだけで、復旧手順も含む。base のファイル編集・ブランチ切替はしない。
  `base/pecot` は `main` を checkout した状態を維持する
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
  リリースは除き、「リリース・nx release group の規約」に従う。
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
