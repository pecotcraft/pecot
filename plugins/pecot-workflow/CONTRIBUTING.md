# pecot-workflow コントリビューション ガイド

このガイドでは、pecot-workflow プラグイン（`plugins/pecot-workflow/`）を改修するときの決まりと、変更を確かめる手順を説明します。

## 1. 成果物テンプレートは cli/templates/ に置く

スキルが作る Issue・PR・コメントの本文の雛形は、`cli/templates/<種別>/<名前>.<ext>` に置きます。スキル（`skills/*/`）には置きません。
MCP サーバは、雛形を `pecot-template://<種別>/<名前>` の resource として出します。スキルは resource を読んで作業ファイルに写し、書き込んでから、そのパスを投稿のツールに渡します。

雛形の定義元を 1 か所にするための決まりです。対話（AskUserQuestion）を伴う雛形でも、雛形は `cli/templates/` に置き、対話はスキルが受け持ちます。

| 置き場所 | 置くもの |
|:---|:---|
| `cli/templates/` | Issue・PR・コメントの本文の雛形。複数のスキルが使うテンプレート |
| `skills/*/` | 手順書（`skills/w-release/references/release-single.md` など）、説明用の例、再利用しない素材 |

スキルの下に雛形が紛れていないかは、次のコマンドで候補を一覧にして確かめます。

```bash
find plugins/pecot-workflow/skills -type f \( -name "*.json" -o -name "*.yaml" -o -name "*.yml" \)
```

## 2. ツール名の決まり

MCP のツールの名前は、2 語を `_` でつないだ `<対象>_<動詞>` にします。前が対象、後ろが動詞と読めます。

- どちらの語も `^[a-z]+$` に合わせる。ハイフンと数字は使わない
- 1 語目は次のグループ、2 語目は次の動詞の語彙から選ぶ
- 同じ対象を扱うツールは、同じ 1 語目に置く

### グループ

| グループ | 扱うもの |
|:---|:---|
| `project` | プロジェクトへの接続と設定ファイル。ボードの上の Issue には触りません |
| `board` | ボードの上の Issue の置き場所。設定ファイルは書きません |
| `issue` | Issue そのもの |
| `session` | 1 つの Issue の作業の始まりから終わりまで（`start`・`show`・`restore`・`finish`） |
| `pr` | PR そのもの |
| `release` | リリース |
| `tracker` | Tracker の Issue の書き直し |
| `worktree` | worktree |
| `branch` | リモートのブランチ |
| `workflow` | 導入先のリポに置く GitHub Actions のワークフロー |

### 動詞の語彙

| 種類 | 動詞 |
|:---|:---|
| 読む | `list`（複数を並べる）・`search`（GitHub を探す）・`show`（1 件を出す）・`get`（設定の値を出す）・`check`（次の操作の前に確かめる）・`doctor`（導入に要る設定がそろっているかを確かめる） |
| 作る・消す | `create`・`delete`（GitHub のもの）・`add`・`remove`（集まりへの出し入れ）・`init`（既存のものを pecot で使えるようにする）・`install`（雛形をリポに書き出す） |
| 設定 | `set`・`unset`（キーの値）・`link`（リポをプロジェクトにつなぐ）・`activate`（使うプロジェクトを切り替える） |
| 作業の流れ | `start`・`restore`・`finish`・`sync`（判定や一覧に合わせて書き直す）・`move`（列を移す）・`merge`（PR を取り込む） |

読む動詞のツールは、何も書き換えません。書き込むツールは、ほかの種類の動詞に置きます。
語彙に無い語を使うときは、先に `libs/workflow-core/src/commands-shared/names.ts` の一覧へ意味と一緒に追加します。追加しないとテストが失敗します。
Issue の作成と作業の開始を 1 つのツールで行う動詞（以前の `quick`）は置きません。作成は公式の MCP の `issue_write`（`issue_check` に通してから）、開始は `session_start` が行います。

GitHub の Issue とコメントに読み書きするツールは置きません。読み書きは GitHub の公式の MCP のツールが担い、pecot は書く前に通すチェックのツールだけを置きます。
チェックのツールは、書く公式のツール 1 つに 1 つ置きます。名前は `<書く公式のツールの対象>_check` です（`issue_dependency_write` には `issue_dependency_check`）。

### 入力名

同じものを指す入力は、ツールが違っても同じ名前にします。

| 指すもの | 入力名 | 例 |
|:---|:---|:---|
| Issue | `issue_ref` | `session_start`・`board_move` |
| PR | `pr_ref` | `pr_show`・`pr_check` |
| リポ | `repo` | `branch_delete`・`project_link` |
| 操作するブランチ | `branch` | `session_start`・`branch_delete` |

- PR の両端を表す `base`・`head` と、真偽値の `delete_branch` は対象外
- チェックのツールは、書く公式のツールの引数の名前（`owner`・`repo`・`issue_number` など）で受け、この表に従わない。公式のツールに渡すのと同じ値を、そのまま通せるようにするためだ
- 名前を変えても、古い名前の別名は作らない。古い名前は、知らない名前として止まる。利用者向けの変更点は version plan に書き、README には移行の手順を書かない
- 書き込むツールは予行の入力を持たない。書き込む前の確かめは、ホストのツールの承認が担う。公式の MCP で書くものは、書く前に check のツールに通す（`issue_write` の前の `issue_check`）

### 次の操作の案内

出力で次の操作を案内するときは、ツールの名前と入力の文字列を直接書きません。
案内は、ツールと入力をデータで渡し、`libs/workflow-core/src/commands-shared/command-hint.ts` の関数で文にします。`project_link with repo: "o/r", develop_branch: "develop"` の形で出ます。

### 決まりを確かめる場所

- `libs/interface-spec` の検証が、定義書（`interface/generated.json`）の全項目の名前を、最上位の `names` と比べる。pecot-visual と pecot-tools の定義書も対象
  - 語彙を変えたら、`cli/scripts/export-interface.ts` で `generated.json` を書き出し直す。書き出し直さないと `diffGenerated` が失敗する
- `cli/src/commands/tests/registry.test.ts` が、すべてのツールの名前を `names.ts` の関数で確かめる
- `cli/tests/interface/` が、対象ごとの入力名を確かめる
- `cli/tests/direct-hint-lint.test.ts` が、`cli/src/` の出力に案内の直書きが無いことを確かめる

## 3. 試験環境

GitHub に書き込む変更は、マージの前に検証用のリポとボードで確かめます。このリポ（`pecotcraft/pecot`）の Issue・PR・ボードには、確かめのために何も作りません。

### 試験環境の一覧

| 名前 | 中身 |
|:---|:---|
| このリポ | `pecotcraft/pecot`。ボードは Projects の 1 番。確かめでは書き込みません |
| 検証用のリポ | `pecotcraft/pecot-sandbox`。確かめで作る Issue・PR・ブランチを置きます |
| 検証用のボード | `pecot sandbox`（Projects の 3 番）。確かめで書き込むボードはこれだけです |
| 検証用の clone | `.pecot/work/<Issue番号>/pecot-sandbox/`。作業ツリーのツールを呼ぶ作業ディレクトリです |

### 作業ツリーのツールを呼ぶ

プラグインの MCP サーバは、npm に出した版です。直したツールを確かめるときは、作業ツリーで build したサーバを、[MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) の CLI で起動して呼びます。

```bash
# 作業ツリーで build する。cli/src・libs/workflow-core を直すたびに打つ
cd <作業ツリー>
pnpm --filter @pecot/workflow-core-src run build && pnpm --filter @pecot/pecot-workflow-cli run build

# 呼ぶ。サーバは、打ったディレクトリを作業ディレクトリにして動く
npx --prefix="$HOME/.cache/pecot-inspector" -y @modelcontextprotocol/inspector@2.5.0 --cli \
  node <作業ツリー>/plugins/pecot-workflow/cli/dist/main.js \
  --method tools/call --tool-name board_show --tool-args-json '{}' --format json
```

- `--prefix` は外さない。`package.json` の無いディレクトリを渡す。外すと、リポの `package.json` の `devEngines` で npm が止まる（`EBADDEVENGINES`）
- ツールの一覧は `--method tools/list`、テンプレートは `--method resources/read --uri pecot-template://comment/plan` で読める
- Inspector は、サーバに `HOME`・`PATH` など 6 つの環境変数しか渡さない。トークンを環境変数だけで持つ環境では、`-e PECOT_GITHUB_COM_TOKEN=<トークン>` を足す。devcontainer では `gh` の認証を使うので要らない
- `-e` は、次のオプションまでの引数を環境変数として読むので、行の最後に置く。サーバのコマンドの前に置くと、サーバを起動できない（`No servers found in config file`）
- 結果は JSON で出る。失敗は `result.isError` が `true` で、`structuredContent.kind` に原因の名前が入る

以下の手順の `<呼ぶ> <ツール> '<入力>'` は、この形で `--tool-name <ツール> --tool-args-json '<入力>'` を渡すことを指します。

### 基本の流れ

検証用に Issue・PR を作るときは、PR を 1 本作るだけの場合も、次の手順で進めます。`<作業ツリー>` は、直している worktree の絶対パスです。

1. 作業ツリーで、検証用の設定がこのリポとずれていないことを確かめる。ずれがあれば、検証用を直してから進める

   ```bash
   plugins/pecot-workflow/scripts/sandbox/sandbox-diff.sh   # 0: ずれなし / 1: ずれあり / 2: 読めない
   ```

2. 検証用の clone を作り、検証用のボードを選ぶ。ボードの設定ファイルは検証用のリポに含まれている

   ```bash
   git clone https://github.com/pecotcraft/pecot-sandbox .pecot/work/<Issue番号>/pecot-sandbox
   cd .pecot/work/<Issue番号>/pecot-sandbox
   <呼ぶ> project_activate '{"project":"github.com_pecotcraft_3.json"}'
   ```

3. 書き込む前に、毎回 `board_show` を呼び、結果の `project.number` が `3` であることを確かめる。ボードの題は出ないので、番号で見る
4. 作るものの名前を決める。`<乱数>` は `[0-9a-z]{4}` の 4 文字、`<Issue番号>` はこのリポで確かめている Issue の番号

   | 作るもの | 名前の形 |
   |:---|:---|
   | ブランチ | `cuj/<Issue番号>-<乱数>`（`session_start` が後ろに `/<検証用の Issue 番号>` を付けた形も含みます） |
   | Issue・PR の題 | `[cuj <Issue番号>-<乱数>]` を含める。pecot が題の先頭に `[Task]` などを付けるので、先頭には置かない |

5. clone の中で、作業ツリーのツールを呼んで作る。`gh pr create`・`gh issue create` は、`-R pecotcraft/pecot-sandbox` を付けても pecot-workflow のフックが止める

   ```bash
   <呼ぶ> issue_check '{"method":"create","issues":[<Issue の値>]}'   # 通ったら、公式の MCP の issue_write で作る
   <呼ぶ> session_start '{"issue_ref":"<Issue>","branch":"<ブランチ>"}'   # リモートにブランチを作るだけで、checkout はしない
   git fetch origin && git checkout <作ったブランチ>
   # 変更を commit して push する
   <呼ぶ> pr_create '{"file":"<PR のファイル>"}'
   ```

   スキル・MCP ツールで作るときは、clone で「直した pecot-workflow を動かす」の手順でクライアントを起動する
6. 確かめが終わったら片付ける。名前の形に合う開いた PR・ブランチ・Issue・カード・リリースが対象

   ```bash
   <作業ツリー>/plugins/pecot-workflow/scripts/sandbox/sandbox-sweep.sh --issue <Issue番号> --dry-run
   <作業ツリー>/plugins/pecot-workflow/scripts/sandbox/sandbox-sweep.sh --issue <Issue番号>
   ```

clone は、確かめるセッションごとに 1 つ作ります。手順 5 で clone の中のブランチを切り替えるため、共有するとぶつかります。
環境に `PECOT_GITHUB_COM_TOKEN`・`GITHUB_COM_TOKEN` が無く、`gh` に認証していれば、`gh auth token` を使うので `.env` は不要です。
別のトークンで書き込むときは、clone の `.pecot/config/.env` に `PECOT_GITHUB_COM_TOKEN=<トークン>` を書きます。そのうえで、環境変数 `PECOT_GITHUB_COM_TOKEN`・`GITHUB_COM_TOKEN` を外します。
`sandbox-sweep.sh` は、名前の形に合わないものと、検証用の `main`・設定ファイルには触りません。`--issue` を省くと、名前の形に合うものをすべて片付けます。
`sandbox-diff.sh` と `sandbox-sweep.sh` は、このリポの `.claude/settings.json` で承認なしに実行できます。
`sandbox-diff.sh` で比べない項目を足すときは、`sandbox-diff-items.json` と spec の表を同じ変更で直します。
このリポの ruleset・ボード・`pecot-board-sync.yml`・`pecot-review.yml`・`pecot-handoff.yml` の決まりを変えるときは、検証用を先に変えます。逆にすると、確かめた結果がこのリポで再現しません。
必須のチェックを足すときは、検証用の `ci.yml`・`codeql.yml` に、同じ名前のジョブを先に足します。検証用のこの 2 つは、チェックの名前を出すだけのスタブです。
`sandbox-diff.sh` は、この 2 つの有無だけを比べ、ジョブの名前は比べません。

### 直した pecot-workflow を動かす

スキル・フックの変更を確かめるときは、検証用の clone でクライアントを起動し、作業ツリーのプラグインを読み込ませます。
`--plugin-dir` には、直した作業ツリーの絶対パスを渡します。base など別の checkout を渡すと、直していない版が動きます。
読み込んだプラグインでも、MCP サーバは `.mcp.json` の npm の版が動きます。直したツールは「作業ツリーのツールを呼ぶ」の形で確かめます。

clone で初めて起動すると、フォルダーを信頼するかを聞かれます。Claude Code では `Yes, I trust this folder` を選びます。GitHub Copilot CLI では `Yes` を選びます。`remember this folder` は `~/.copilot/settings.json` を書き換えるので選びません。

#### Claude Code

```bash
cd .pecot/work/<Issue番号>/pecot-sandbox
claude --plugin-dir <作業ツリー>/plugins/pecot-workflow plugin list --json   # pecot-w@inline の installPath が作業ツリーを指すこと
claude --plugin-dir <作業ツリー>/plugins/pecot-workflow
```

起動後に `/mcp` を開き、`plugin:pecot-w:pecot-workflow` が 1 つだけであることを確かめます。2 つあるときは、インストール済みの pecot-w を `/plugin` で無効にしてから起動し直します。

#### Remote Control

`claude remote-control` は `--plugin-dir` を受け付けません。作業ツリーのルートで次を打つと、その作業ツリーの pecot-w・pecot-t・pecot-v を読み込んで起動します。後ろのオプションは `claude remote-control` にそのまま渡ります。

```bash
.devcontainer/scripts/pecot-rc.sh --spawn worktree
```

プラグインは、環境変数 `CLAUDE_CODE_PLUGIN_DIRS` で渡します。マーケットプレイスの登録とインストール済みのプラグインは変えないので、worktree ごとに別の版で起動できます。

新しいセッションは auto モードで始まります。設定ファイルの `permissions.defaultMode` では auto を既定にできないので、`pecot-rc.sh` が `--permission-mode auto` を渡します。別のモードで始めたいときは、`--permission-mode <モード>` を付けて打ちます。

レイアウトにある worktree をまとめて起動するときは、ホストで `pecot-open.sh`・`pecot-open-mobile.sh` に `--rc` を付けます。新しく作るペイン（セッション）ごとに、その worktree で `pecot-rc.sh` が動きます。止めるときは、そのペインで Ctrl-C を押します。

```bash
.devcontainer/tmux/pecot-open.sh --layout parallel-a --rc
```

1 つのフォルダーで動かせる Remote Control は 1 つだけです。同じ worktree を 2 回置いたレイアウトでは、後のペインの起動が止まります。

#### GitHub Copilot CLI

```bash
cd .pecot/work/<Issue番号>/pecot-sandbox
COPILOT_PLUGIN_DIR_ONLY=true copilot --plugin-dir <作業ツリー>/plugins/pecot-workflow
```

`COPILOT_PLUGIN_DIR_ONLY=true` を付けると、`--plugin-dir` のプラグインだけを読み込みます。pecot-v など、ほかのプラグインも読み込みません。付けないと、インストール済みの pecot-w のフックも一緒に動きます。
起動後に `/env` を開き、Skills のパスが作業ツリーを指すこと、Hooks の sources が `pecot-w` だけであることを確かめます。
エージェントに渡った本文を確かめるには、`--log-level all --log-dir <ディレクトリ>` を付けて起動し、ログの `instructions` から直した文を探します。

#### 直しを反映させる

| 直したもの | Claude Code | GitHub Copilot CLI |
|:---|:---|:---|
| スキル | `/reload-plugins` | `/skills reload` |
| エージェント | `/reload-plugins` | 不要（呼ぶたびに読み直します） |
| フックのスクリプト | 不要 | 不要 |
| `hooks.json` | `/reload-plugins` | 起動し直します（`/restart` では反映されません） |
| `.mcp.json`・`mcp.json` | `/reload-plugins` | `/mcp reload` |

MCP サーバ（`cli/src`）の直しは、クライアントに反映されません。作業ツリーで build し直し、「作業ツリーのツールを呼ぶ」の形で呼びます。

### 配る自動化を確かめる

利用者に配る workflow は、このリポの `main` の `.github/workflows/` と同じ写しを、検証用の `main` にも置いています。`sandbox-diff.sh` は、テンプレートではなく、この 2 つの写しを比べます。

検証用には `actions/` がありません。検証用の写しは、pecot の action を `pecotcraft/pecot/actions/<処理>@main` で呼びます。このリポだけの step（`Check out the pecot actions`）も持ちません。`sandbox-diff.sh` は、この 2 つの違いをそろえてから比べます。

| 配るもの | `sandbox-diff.sh` の比べ方 | 確かめの手順 |
|:---|:---|:---|
| ボードの同期（`pecot-board-sync.yml`） | 有無と中身 | この節の手順 1〜6 |
| 自動レビュー（`pecot-review.yml`） | 有無と中身 | `specs/027-auto-revise-on-pr/quickstart.md` |
| 引き継ぎ（`pecot-handoff.yml`） | 有無と中身 | この節の「引き継ぎを確かめる」 |
| 手の無い操作（`pecot-github-ops.yml`） | 有無と中身 | `pecotcraft/pecot` の `specs/031-pecot-coordinator/tasks.md` の T073。手順 1〜3・5・6 で写しを入れて戻し、手順 4 の代わりに `actions_run_trigger` で operation ごとに起動する |

検証用にも自動レビューの写しがあるので、検証用で作る draft でない PR には、自動レビューが付きます。
自動レビューを quickstart で確かめるときは、次の 2 つに気を付けます。

- 検証用には写しが既にあるので、`workflow_install`（`review`）は上書きになる
- 確かめの後に、写しをこのリポの `main` の `.github/workflows/pecot-review.yml` と同じ中身に戻す PR を入れる。その後、`sandbox-diff.sh` でずれが 0 件であることを確かめる

利用者に配る `actions/templates/pecot-board-sync.yml` や、それが呼ぶ pecot の action を直したときは、マージの前に動かします。検証用の `.github/workflows/` に入れます。`uses:` は、作業ブランチの `actions/<処理>/dist/index.js` を読みます。
検証用の `main` の workflow を書き換えるので、この確かめは一度に 1 人で行います。

1. 作業ツリーで `pnpm exec nx run pecot-actions:build` を打って `dist` を作り直し、作業ブランチに commit して push する
2. 作業ツリーのテンプレートを写し、`pecotcraft/pecot/actions/<処理>@pecot-actions/v<版>` の `@` の後ろだけを作業ブランチの名前に置き換える
3. 検証用の clone で、写しを入れる PR を「基本の流れ」の手順で作り、`pr_merge` で merge queue に入れる。`workflow_dispatch`・`pull_request_target`・`issues` は既定のブランチの定義で動くので、マージするまで直した定義では動かない
4. PR・Issue を変えるか、`gh workflow run pecot-board-sync.yml -R pecotcraft/pecot-sandbox` で起動し、次の 2 つを確かめる
   - 実行の `Sync the board` の step が成功し、ログに `moved:`・`set:` の行が出ること
   - `board_show` の `project.number` が 3 で、動かす見込みのカードの列か Status が変わったこと
5. 写しを、このリポの `main` の `.github/workflows/pecot-board-sync.yml` から作った形に戻す PR を入れる。pecot の action の呼び方は `pecotcraft/pecot/actions/<処理>@main` にする
6. `sandbox-diff.sh` でずれが 0 件であることを確かめる

定期の起動は検証用には届きません。検証用の写しは `schedule` を持ちません。このリポの Lambda（`.github/board-sync/`）は、`handler.mjs` がリポの ID を比べて、`pecotcraft/pecot` だけを起動します。

#### 引き継ぎを確かめる

検証用には引き継ぎの写しもあるので、検証用で PR をマージすると、親 Epic に merge-diff が付きます。
直した w-handoff と `pecot-handoff.yml` は、マージの前に、検証用の写しを一時的に替えて動かします。

1. 写しに、作業ブランチの SHA を `pecot-src` へ checkout する step を足す
2. claude-code-action の `plugin_marketplaces` を `./pecot-src` にする。`./` で始まる値は、ローカルのマーケットプレイスとして渡る。`#<ref>` を付けた URL は受けない
3. `plugins` は `pecot-w@pecot` のままにする
4. 写しを検証用の `main` に入れてから、検証用で PR をマージし、Epic と後続の Issue のコメントと実行の結果を読む
5. 確かめの後に、写しをこのリポの `main` の `.github/workflows/pecot-handoff.yml` と同じ中身に戻す PR を入れる。その後、`sandbox-diff.sh` でずれが 0 件であることを確かめる

### このリポだけの運用

次の運用はこのリポだけで動き、利用者へは配りません。検証用には確かめる場所を作りません。

| 運用 | 確かめ方 |
|:---|:---|
| リリース（`release.yml`・`publish-npm.yml`） | `gh workflow run release.yml --ref main` の dry-run で案を見ます。配布ツリーは `publish-mcp-dist.sh --dry-run` で作ります。workflow の形は `.githooks/tests/test_release_workflow.py`・`test_publish_npm_workflow.py` |
| 依存の更新と脆弱性の通知（`dependabot-*.yml`・`security-alerts.yml`） | `.githooks/tests/test_dependabot_commit_workflow.py`。Tracker を作る pecot の action の tracker-sync は `actions/tests/interface/tracker-sync-*.test.ts` |
| workflow を外から起動する仕組み（`.github/board-sync/` の Lambda と Scheduler） | `.github/board-sync/handler.test.mjs`（`.githooks/tests/test_board_sync.py` から実行） |
| Issue の機能の写しと今のスキーマの比べ（`issue-surface-drift.yml`） | workflow の形は `.githooks/tests/test_issue_surface_workflow.py`。比べと Tracker の扱いは、「4. GitHub の Issue の機能の写しと担保の一覧」の「定期の確かめ」の打ち方で確かめます |
| 公開サイト（`pages-build.yml`・`pages-deploy.yml`・保管ブランチ `pages-store`） | workflow の形と判定は `.githooks/tests/test_pages_*.py`。公開はマージの後に実物で確かめます。手順は `specs/028-pages-site/quickstart.md`、起動とやり直しは `.claude/rules/pages-site.md` |

利用者へ配るもの（workflow・Lambda など）を新しく作ったときは、検証用に確かめる場所を作ります。

### GitHub に書き込む処理の一覧

定義書（`interface/authored.yaml`）の effects から、GitHub に書き込む処理を拾った一覧です。
対象は、`target: github` で `kind` が `write` か `destructive` のものです。remote へ push する `target: git` のもの（`pr_restack` だけ）も含みます。
MCP のツール名は、CLI のコマンドの 2 語を `_` でつないだ形です。「sweep」は `sandbox-sweep.sh` で片付くことを表します。
Issue・コメント・前提・カードの欄を公式の MCP で書いたものは、この一覧に載りません。検証用で作った Issue は、sweep が閉じます（コメントと値は残ります）。

| MCP ツール | 作るもの・変えるもの | 片付け方・注意 |
|:---|:---|:---|
| `board_add` | カードと Status | sweep（カードをアーカイブ） |
| `board_move` | カードの Status | sweep |
| `branch_delete` | リモートブランチの削除 | 不要。その head の PR は GitHub が閉じます |
| `pr_create` | PR・スタックへの登録・カードの Status | sweep（PR を閉じる） |
| `pr_merge` | PR のマージか merge queue への投入 | マージした PR と commit は検証用の `main` に残ります |
| `pr_restack` | 手元のブランチの rebase と `git push --force-with-lease` | sweep。対象はスタック PR だけです |
| `project_create` | org のボードとフィールド | 題に `[cuj <Issue番号>-<乱数>]` を入れて作り、`gh project delete <番号> --owner pecotcraft` で消します。作ると新しいボードが有効になるので、`project activate` で戻します |
| `project_init` | ボードのフィールドと選択肢 | 題に `[cuj <Issue番号>-<乱数>]` を入れて `gh project create` で作った空のボードで実行し、`gh project delete` で消します |
| `project_link` | リポとプロジェクトのつなぎ | `gh project unlink <番号> --owner pecotcraft --repo pecotcraft/pecot-sandbox` |
| `release_create` | `v*` のリリースとタグ | `gh release delete <タグ> --cleanup-tag --yes -R pecotcraft/pecot-sandbox`。版の節を書いた `CHANGELOG.md` を clone に一時的に置いて実行します |
| `release_merge` | release の PR のマージと head ブランチの削除 | 検証用では実行できません。このリポだけの bypass で通す操作で、検証用には bypass を足しません |
| `session_start` | 紐づいたブランチ・カードの Status を `active` に | sweep（ブランチを消す） |
| `session_finish` | Issue のクローズ・リモートの head ブランチの削除 | カードは sweep がアーカイブします |
| （配る workflow の `pecot-board-sync.yml`） | PR・Issue の変化で、pecot の action の board-sync と session-finish を動かす。board-sync は新しい 20 件を超えた Archived のカードを削除します | 「配る自動化を確かめる」の手順で入れて戻します。削除は戻せません |
| （配る workflow の `pecot-github-ops.yml`） | 起動した operation のブランチ・スタック・ボードの欄とビュー・リポのつなぎ・リリース | ブランチ・スタックは sweep。ボードは `project_init` と同じく使い捨てを作って消します。つなぎとリリースは `project_link`・`release_create` の行と同じ |

## 4. GitHub の Issue の機能の写しと担保の一覧

pecot が GitHub の Issue の機能をどこまで扱うかを、次の 2 つのファイルで記録します。GitHub が機能を足したときに、扱いの決まっていない項目を PR の CI で見つけるためです。

| ファイル | 中身 |
|:---|:---|
| `interface/github-issue-surface.json` | 写し。公開スキーマ（GraphQL の SDL）と REST の OpenAPI から、Issue の機能に関わる項目の `id` を抜いた一覧と、取った URL・日時・REST の版 |
| `interface/issue-coverage.yaml` | 担保の一覧。写しの各項目を、`supported`（扱う）か `excluded`（外す）にする |

写しに入る項目と `id` の形は次のとおりです。

| 項目 | `id` の形 |
|:---|:---|
| `CreateIssueInput`・`UpdateIssueInput`・`ProjectV2FieldValue` の項目 | `graphql:<型>.<項目>` |
| `ProjectV2FieldType`・`ProjectV2CustomFieldType`・`IssueFieldDataType` の値 | `graphql:enum:<型>.<値>` |
| Issue を対象にする mutation。`input` の項目のうち、`@possibleTypes` の `concreteTypes` が `["Issue"]` だけのものを持つ mutation | `graphql:mutation:<名前>` |
| REST の Issue の作成（`POST /repos/{owner}/{repo}/issues`）の本文の項目 | `rest:POST /repos/{owner}/{repo}/issues#<項目>` |

担保の一覧の各項目は、`id`・`status` と、`status` に応じた次の鍵を 1 つ持ちます。

| `status` | 鍵 | 書くもの |
|:---|:---|:---|
| `supported` | `handler` | 値を書く `cli/src/domain/attributes.ts` の `ATTRIBUTE_HANDLERS` の鍵 |
| `supported` | `tool` | 属性でなく、ツールが書く項目（題・本文・状態・parent・blocked_by など）の MCP のツール名 |
| `excluded` | `reason` | 外す理由。preview・GitHub が計算する・pecot の流れの外 など |

### 写しを作り直す

写しは、REST の版を pecot が REST に送る版（`cli/src/infra/github/client.ts` の `DEFAULT_API_VERSION`）に合わせて作ります。`--api-version` を省くと、その版になります。

```bash
pnpm --dir plugins/pecot-workflow/cli exec tsx scripts/github-surface/extract.ts --out ../interface/github-issue-surface.json
```

PR の CI は写しだけを読み、GitHub には取りに行きません。

### 定期の確かめ

`.github/workflows/issue-surface-drift.yml` が、GitHub の今のスキーマを写しと比べます。`.github/board-sync/` の Lambda の Scheduler が、毎時 dispatch します。

差は、pecot の action の tracker-sync が立てる Tracker と同じ形の Tracker 1 件にまとめます。ラベルは `issue-surface` で、題は `[Tracker] GitHub issue surface — <立てた日>` です。
本文には、`list-begin`・`list-end` の間に、見ている先（`## Source`）と、増えた項目（`## Added`）・消えた項目（`## Removed`）の `id` だけを並べます。

| 差 | 開いた Tracker | 動き |
|:---|:---|:---|
| 無い | 無い | 何もしない |
| ある | 無い | Tracker を作り、ボードの Backlog に載せる |
| ある | ある | 一覧を書き直す。一覧が同じなら書かない |
| 無い | ある | 一覧を `none` に書き直し、Tracker を閉じる |

Tracker ができたら、「写しを作り直す」の手順で写しを作り直し、「網羅のテストが落ちたとき」の表で担保の一覧を直します。その PR がマージされると、次の実行で Tracker が閉じます。

手元で比べの結果を見るときは、`--dry-run` を付けて実行します。書き込まずに、予定の操作（`dry-run: would create Tracker …` など）を出します。

```bash
pnpm --dir plugins/pecot-workflow/cli exec tsx scripts/github-surface/drift.ts --repo pecotcraft/pecot --dry-run
```

`--sdl <ファイル>`・`--openapi <ファイル>` を渡すと、そのファイルを GitHub の今のスキーマの代わりに読みます。

書き込む確かめは、`--repo pecotcraft/pecot-sandbox` にして、検証用の clone を `CLAUDE_PROJECT_DIR` に渡して打ちます。
題に `[cuj …]` が入らないので、`sandbox-sweep.sh` は片付けません。できた Issue を `gh issue close <番号> -R pecotcraft/pecot-sandbox` で閉じます。

### 網羅のテストが落ちたとき

`cli/tests/issue-coverage.test.ts` が、写しと担保の一覧を照らします。落ちたときは、メッセージの `id` ごとに次のように直します。

| メッセージ | 直し方 |
|:---|:---|
| `not in issue-coverage.yaml` | 担保の一覧に足します。扱うなら `handler` か `tool` を、外すなら `reason` を書きます。扱うのに受け持つ処理が無ければ、`ATTRIBUTE_HANDLERS` の kind かツールを作ってから足します |
| `not in github-issue-surface.json` | GitHub が項目を消しています。担保の一覧から外し、その項目を扱う処理が残っていれば直します |
| `supported needs exactly one of handler or tool` | `handler` と `tool` のどちらか 1 つだけを書きます |
| `handler ... is not in ATTRIBUTE_HANDLERS`・`tool ... is not an MCP tool of TOOLS` | 名前を直すか、消えた処理の代わりを書きます |
| `excluded needs a reason` | 外す理由を書きます |
| `excluded must not have handler or tool` | 外す項目から `handler`・`tool` を消します。扱うなら `status` を `supported` にします |
| `supported must not have a reason` | 扱う項目から `reason` を消します。外すなら `status` を `excluded` にします |
| `listed more than once` | 重なった項目を 1 つにします |
