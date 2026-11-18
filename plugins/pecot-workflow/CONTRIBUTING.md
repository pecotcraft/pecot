# pecot-workflow コントリビューション ガイド

このガイドでは、pecot-workflow プラグイン（`plugins/pecot-workflow/`）を改修するときの決まりと、変更を確かめる手順を説明します。

## 1. 成果物テンプレートは CLI 側に置く

スキルが作る Issue・PR・コメントの本文の雛形は、`cli/templates/<種別>/<名前>.<ext>` に置きます。スキル（`skills/*/`）には置きません。
スキルは `--prepare`（MCP ツールでは `prepare: true`）でテンプレートを作業ファイルに写し、そのパスを受け取って書き込みます。

雛形の定義元を 1 か所にするための決まりです。対話（AskUserQuestion）を伴う雛形でも、雛形は CLI に置き、対話はスキルが受け持ちます。

| 置き場所 | 置くもの |
|:---|:---|
| `cli/templates/` | Issue・PR・コメントの本文の雛形。複数のスキルが使うテンプレート |
| `skills/*/` | 手順書（`skills/w-release/references/release-single.md` など）、説明用の例、再利用しない素材 |

スキルの下に雛形が紛れていないかは、次のコマンドで候補を一覧にして確かめます。

```bash
find plugins/pecot-workflow/skills -type f \( -name "*.json" -o -name "*.yaml" -o -name "*.yml" \)
```

## 2. コマンド名の決まり

コマンドの名前（`path`）は、`<対象> <動詞>` の 2 語にします。MCP のツール名は 2 語を `_` でつないだ `<対象>_<動詞>` になり、前が対象、後ろが動詞と読めます。

- どちらの語も `^[a-z]+$` に合わせる。ハイフンと数字は使わない
- 1 語目は次のグループ、2 語目は次の動詞の語彙から選ぶ
- 同じ対象を扱うコマンドは、同じ 1 語目に置く
- 起動の語である `pecot mcp` は対象外

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
| Issue | `comment`・`reopen`・`block`・`unblock` |

読む動詞のコマンドは、何も書き換えません。書き込むコマンドは、ほかの種類の動詞に置きます。
語彙に無い語を使うときは、先に `cli/src/commands/names.ts` の一覧へ意味と一緒に追加します。追加しないとテストが失敗します。
Issue の作成と作業の開始を 1 つのコマンドで行う動詞（以前の `quick`）は置きません。作成は `issue create`（`freeform`）、開始は `session start` が行います。

### 入力名

同じものを指す入力は、コマンドが違っても同じ名前にします。

| 指すもの | 入力名 | 例 |
|:---|:---|:---|
| Issue | `issue_ref` | `issue comment`・`session start`・`board move` |
| PR | `pr_ref` | `pr show`・`pr check` |
| リポ | `repo` | `branch delete`・`project link` |
| 操作するブランチ | `branch` | `session start`・`branch delete` |

- PR の両端を表す `base`・`head` と、真偽値の `delete_branch` は対象外
- 名前を変えても、古い名前の別名は作らない。`cli/src/commands/renamed-commands.ts` に追加し、古い名前で呼ばれたら新しい名前を案内して止める。利用者向けの変更点は version plan に書き、README には移行の手順を書かない
- 書き込むコマンド（effects に `write` か `destructive` を持つもの）には、入力 `dry_run`（CLI では `--dry-run`・`-n`）を付ける。予行でも入力の検証と読み取りは行い、書き込みの直前で `dry-run: would ...` の行を出して終わる

### 次の操作の案内

出力で次の操作を案内するときは、`pecot <グループ> <動詞>` の文字列を直接書きません。MCP で呼ぶエージェントは `pecot` のコマンドを打てないためです。
案内は、コマンドの path と入力をデータで渡し、`cli/src/domain/command-hint.ts`・`cli/src/commands/command-hint.ts` の関数で文にします。
CLI では `pecot project link o/r --develop-branch develop` の形で出ます。MCP では `project_link with repo: "o/r", develop_branch: "develop"` の形で出ます。
`--help` の examples は CLI にだけ出るので、`pecot ...` のまま書いて構いません。

### 決まりを確かめる場所

- `libs/interface-spec` の検証が、定義書（`interface/generated.json`）の全項目の名前を、最上位の `names` と比べる。pecot-visual と pecot-tools の定義書も対象
  - 語彙を変えたら、`cli/scripts/export-interface.ts` で `generated.json` を書き出し直す。書き出し直さないと `diffGenerated` が失敗する
- `cli/src/commands/tests/registry.test.ts` が、すべてのコマンドの path を `names.ts` の関数で確かめる
- `cli/tests/interface/` が、書き込むコマンドの `dry_run` と、対象ごとの入力名を確かめる
- `cli/tests/direct-hint-lint.test.ts` が、`cli/src/` の出力に `pecot <グループ>` の直書きが無いことを確かめる

## 3. 試験環境

GitHub に書き込む変更は、マージの前に検証用のリポとボードで確かめます。このリポ（`pecotcraft/pecot`）の Issue・PR・ボードには、確かめのために何も作りません。

### 試験環境の一覧

| 名前 | 中身 |
|:---|:---|
| このリポ | `pecotcraft/pecot`。ボードは Projects の 1 番。確かめでは書き込みません |
| 検証用のリポ | `pecotcraft/pecot-sandbox`。確かめで作る Issue・PR・ブランチを置きます |
| 検証用のボード | `pecot sandbox`（Projects の 3 番）。確かめで書き込むボードはこれだけです |
| 検証用の clone | `.pecot/work/<Issue番号>/pecot-sandbox/`。`pecot` を動かす作業ディレクトリです |

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
   <作業ツリー>/plugins/pecot-workflow/bin/pecot project activate github.com_pecotcraft_pecot-sandbox_sandbox.json
   ```

3. 書き込む前に、毎回 `pecot board show --json`（MCP では `board_show`）を実行し、`project.number` が `3` であることを確かめる。ボードの題は出ないので、番号で見る
4. 作るものの名前を決める。`<乱数>` は `[0-9a-z]{4}` の 4 文字、`<Issue番号>` はこのリポで確かめている Issue の番号

   | 作るもの | 名前の形 |
   |:---|:---|
   | ブランチ | `cuj/<Issue番号>-<乱数>`（`session start` が後ろに `/<検証用の Issue 番号>` を付けた形も含みます） |
   | Issue・PR の題 | `[cuj <Issue番号>-<乱数>]` を含める。pecot が題の先頭に `[Task]` などを付けるので、先頭には置かない |
   | リリースのタグ | `cuj/<Issue番号>-<乱数>-tgz`。`--latest=false` で作ります |

5. clone の中で、作業ツリーの `bin/pecot` を使って作る。`gh pr create`・`gh issue create` は、`-R pecotcraft/pecot-sandbox` を付けても pecot-workflow のフックが止める

   ```bash
   <作業ツリー>/plugins/pecot-workflow/bin/pecot issue create ...
   <作業ツリー>/plugins/pecot-workflow/bin/pecot session start ...   # リモートにブランチを作るだけで、checkout はしない
   git fetch origin && git checkout <作ったブランチ>
   # 変更を commit して push する
   <作業ツリー>/plugins/pecot-workflow/bin/pecot pr create ...
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
このリポの ruleset・ボード・`pecot-board-sync.yml`・`pecot-review.yml` の決まりを変えるときは、検証用を先に変えます。逆にすると、確かめた結果がこのリポで再現しません。

### 直した pecot-workflow を動かす

スキル・MCP ツール・フックの変更を確かめるときは、検証用の clone でクライアントを起動し、作業ツリーのプラグインを読み込ませます。
`--plugin-dir` には、直した作業ツリーの絶対パスを渡します。base など別の checkout を渡すと、直していない版が動きます。

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
| MCP サーバ（`cli/src`） | `/mcp` で `plugin:pecot-w:pecot-workflow` の Reconnect を選び、`/clear` します | `/mcp reload pecot-workflow` |
| `hooks.json` | `/reload-plugins` | 起動し直します（`/restart` では反映されません） |
| `.mcp.json`・`mcp.json` | `/reload-plugins` | `/mcp reload` |

MCP サーバを起動し直すと、`bin/pecot` が `cli/src` からビルドし直します。
Claude Code では、Reconnect の後も、会話に読み込み済みのツール定義が古いまま残ります。`/clear` で新しい会話にします。会話を残したいときは、セッションを始め直します。

### 配る自動化を確かめる

利用者に配る workflow は、このリポの `main` の `.github/workflows/` と同じ写しを、検証用の `main` にも置いています。`sandbox-diff.sh` は、テンプレートではなく、この 2 つの写しを比べます。

| 配るもの | `sandbox-diff.sh` の比べ方 | 確かめの手順 |
|:---|:---|:---|
| ボードの同期（`pecot-board-sync.yml`） | 有無と中身 | この節の手順 1〜8 |
| 自動レビュー（`pecot-review.yml`） | 有無と中身 | `specs/027-auto-revise-on-pr/quickstart.md` |

検証用にも自動レビューの写しがあるので、検証用で作る draft でない PR には、自動レビューが付きます。
自動レビューを quickstart で確かめるときは、次の 2 つに気を付けます。

- 検証用には写しが既にあるので、`pecot workflow install review` は上書きになる
- 確かめの後に、写しをこのリポの `main` の `.github/workflows/pecot-review.yml` と同じ中身に戻す PR を入れる。その後、`sandbox-diff.sh` でずれが 0 件であることを確かめる

利用者に配る `cli/templates/workflow/pecot-board-sync.yml` を直したときは、マージの前に検証用の `.github/workflows/` に入れて動かします。テンプレートは npm の `@pecot/workflow-mcp` を `npx` で取得するので、直した中身は作業ツリーから作った tgz で渡します。
検証用の `main` の workflow を書き換えるので、この確かめは一度に 1 人で行います。

1. 作業ツリーで配布ツリーを作る。`<版>` は `.claude-plugin/plugin.json` の版

   ```bash
   OUT=<リポの外にある、空か存在しないディレクトリ>
   bash plugins/pecot-workflow/scripts/release/publish-mcp-dist.sh --dry-run --version=<版>-cuj.<Issue番号>.r<乱数> --out-dir="$OUT"
   ```

   worktree では `.pecot/work/<Issue番号>/dist` を使える（実体が base にあり、リポの外になるため）。base では使えない。版の `r` は、数字だけの `<乱数>` でも semver として有効にするためのもの
2. `$OUT` で `npm pack --pack-destination <置き場>` を実行する。リポの中で実行すると、ルートの devEngines で止まる
3. tgz を検証用のリリースに添付し、URL から直した版を取得できることを確かめる

   ```bash
   gh release create cuj/<Issue番号>-<乱数>-tgz <tgz> --latest=false --target main -R pecotcraft/pecot-sandbox
   gh api repos/pecotcraft/pecot-sandbox/releases/tags/cuj/<Issue番号>-<乱数>-tgz --jq '.assets[0].browser_download_url'
   npx -y --prefix=/ <URL> --version   # pecot version <版>-cuj.<Issue番号>.r<乱数> と出ること
   ```

4. 作業ツリーのテンプレートを写し、`@pecot/workflow-mcp@latest` だけをその URL に置き換える
5. 検証用の clone で、写しを入れる PR を「基本の流れ」の手順で作り、`pecot pr merge` で merge queue に入れる。`workflow_dispatch`・`pull_request_target`・`issues` は既定のブランチの定義で動くので、マージするまで直した定義では動かない
6. PR・Issue を変えるか、`gh workflow run pecot-board-sync.yml -R pecotcraft/pecot-sandbox` で起動し、次の 2 つを確かめる
   - 実行の `Sync the board` の step が、URL を使う `npx` の行で成功すること
   - `pecot board show --json` の `project.number` が 3 で、動かす見込みのカードの列か Status が変わったこと
7. 写しを、このリポの `main` の `.github/workflows/pecot-board-sync.yml` と同じ中身に戻す PR を入れる
8. `sandbox-diff.sh` でずれが 0 件であることを確かめてから、`sandbox-sweep.sh` でリリースを消す。順が逆だと、消えた URL を取りに行く実行が失敗する

定期の起動は検証用には届きません。検証用の写しは `schedule` を持ちません。このリポの Lambda（`.github/board-sync/`）は、`handler.mjs` がリポの ID を比べて、`pecotcraft/pecot` だけを起動します。

### このリポだけの運用

次の運用はこのリポだけで動き、利用者へは配りません。検証用には確かめる場所を作りません。

| 運用 | 確かめ方 |
|:---|:---|
| リリース（`release.yml`・`publish-npm.yml`） | `gh workflow run release.yml --ref main` の dry-run で案を見ます。配布ツリーは `publish-mcp-dist.sh --dry-run` で作ります。workflow の形は `.githooks/tests/test_release_workflow.py`・`test_publish_npm_workflow.py` |
| 依存の更新と脆弱性の通知（`dependabot-*.yml`・`security-alerts.yml`） | `.githooks/tests/test_dependabot_commit_workflow.py`。Tracker を作る `pecot tracker sync` は検証用で実行できます |
| workflow を外から起動する仕組み（`.github/board-sync/` の Lambda と Scheduler） | `.github/board-sync/handler.test.mjs`（`.githooks/tests/test_board_sync.py` から実行） |
| 公開サイト（`pages-build.yml`・`pages-deploy.yml`・保管ブランチ `pages-store`） | workflow の形と判定は `.githooks/tests/test_pages_*.py`。公開はマージの後に実物で確かめます。手順は `specs/028-pages-site/quickstart.md`、起動とやり直しは `.claude/rules/pages-site.md` |

利用者へ配るもの（workflow・Lambda など）を新しく作ったときは、検証用に確かめる場所を作ります。

### GitHub に書き込む処理の一覧

定義書（`interface/authored.yaml`）の effects から、GitHub に書き込む処理を拾った一覧です。
対象は、`target: github` で `kind` が `write` か `destructive` のものです。remote へ push する `target: git` のもの（`pr_restack` だけ）も含みます。
MCP のツール名は、CLI のコマンドの 2 語を `_` でつないだ形です。「sweep」は `sandbox-sweep.sh` で片付くことを表します。

| MCP ツール | 作るもの・変えるもの | 片付け方・注意 |
|:---|:---|:---|
| `board_add` | カードと Status | sweep（カードをアーカイブ） |
| `board_move` | カードの Status | sweep |
| `board_sync` | カードの列と Status。新しい 20 件を超えた Archived のカードを削除 | 名前の形のものは sweep。削除は戻せません |
| `branch_delete` | リモートブランチの削除 | 不要。その head の PR は GitHub が閉じます |
| `issue_block`・`issue_unblock` | blocked-by・Issue の本文・カードの列 | sweep |
| `issue_comment` | Issue のコメント | Issue ごと sweep が閉じます（コメントは残ります）。`-m` で送るときは `-t` で種類を渡します |
| `issue_create` | Issue・blocked-by・カード・sub-issue | sweep |
| `issue_reopen` | Issue の再オープン・カードのアーカイブ解除・Status の `Done` の削除 | sweep |
| `pr_create` | PR・スタックへの登録・カードの Status | sweep（PR を閉じる） |
| `pr_merge` | PR のマージか merge queue への投入 | マージした PR と commit は検証用の `main` に残ります |
| `pr_restack` | 手元のブランチの rebase と `git push --force-with-lease` | sweep。対象は積んだ PR だけです |
| `project_create` | org のボードとフィールド | 題に `[cuj <Issue番号>-<乱数>]` を入れて作り、`gh project delete <番号> --owner pecotcraft` で消します。作ると新しいボードが有効になるので、`project activate` で戻します |
| `project_init` | ボードのフィールドと選択肢 | 題に `[cuj <Issue番号>-<乱数>]` を入れて `gh project create` で作った空のボードで実行し、`gh project delete` で消します |
| `project_link` | リポとプロジェクトのつなぎ | `gh project unlink <番号> --owner pecotcraft --repo pecotcraft/pecot-sandbox` |
| `release_create` | `v*` のリリースとタグ | `gh release delete <タグ> --cleanup-tag --yes -R pecotcraft/pecot-sandbox`。版の節を書いた `CHANGELOG.md` を clone に一時的に置いて実行します |
| `release_merge` | release の PR のマージと head ブランチの削除 | 検証用では実行できません。このリポだけの bypass で通す操作で、検証用には bypass を足しません |
| `session_start` | 紐づいたブランチ・カードの Status を `active` に | sweep（ブランチを消す） |
| `session_finish` | Issue のクローズ・リモートの head ブランチの削除 | カードは sweep がアーカイブします |
| `tracker_sync` | Tracker の Issue（題に `[cuj …]` が付きません）・カード | 作った Issue を `gh issue close <番号> -R pecotcraft/pecot-sandbox` で閉じます |
| （配る workflow の `pecot-board-sync.yml`） | PR・Issue の変化で `board_sync` を動かす | 「配る自動化を確かめる」の手順で入れて戻します |
