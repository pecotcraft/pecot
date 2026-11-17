# pecot-workflow プラグイン コントリビューション ガイド

このドキュメントは pecot-workflow プラグイン (`plugins/pecot-workflow/`) を改修する際の規約を記載します。

## 1. 成果物テンプレートは CLI 側に置く

### ルール

pecot スキルが生成する成果物 (Issue 本文 / PR 本文 / コメント本文) の雛形ファイルは、CLI 側に置いてください。
置き場所は `plugins/pecot-workflow/cli/templates/<種別>/<名前>.<ext>` です。
スキル本体 (`plugins/pecot-workflow/skills/*/`) には置かないでください。

スキルは `pecot <command> --prepare` を呼び出して prepared file の絶対パスを取得し、それを Read して編集・書き出しを行います。

### 理由

- SKILL.md とテンプレ実体の二重管理を避け、テンプレ書式・プレースホルダの定義元を 1 箇所に保つため
- `pecot <cmd> --prepare` が prepared file の path を stdout に返す I/O 規約が固定されているため、スキル側ロジックの再現性が上がる
- レビュアー / AI が「テンプレを差し替えるなら CLI 側を触る」という単純規則で逸脱を検知できる
- 対話ロジック (AskUserQuestion 等) を伴う雛形でも本ルールは適用する。CLI は AskUserQuestion を扱えないため、テンプレ実体は CLI に置き、対話処理はスキル側で行う責務分割となる

### 境界条件 (skill 配下に置いてよいもの)

- 手順書 / プロセス説明 (`skills/w-release/references/release-single.md` 等)
- 特定シナリオの説明素材・scenario sample
- テンプレ化に値しない一過性の素材 (再利用されない説明用 snippet 等)

### 境界条件 (CLI 配下に置くべきもの)

- 出力先が `.pecot/tmp/output/` を経由する性質のもの (Issue/PR/コメント body 雛形)
- 複数のスキルから参照される共通テンプレ
- バージョン管理で「定義元がどこか」を一意に定めたいテンプレ

### 検証手順

定期的に以下のコマンドで雛形候補を列挙し、各ファイルが「procedure documentation」か「artifact template」かをレビューしてください。

```bash
find plugins/pecot-workflow/skills -type f \( -name "*.json" -o -name "*.yaml" -o -name "*.yml" \)
```

artifact template が見つかったら本ルールに従って `plugins/pecot-workflow/cli/templates/` 配下へ移送することが望ましいです。

### 直近の集約事例

- #516 w-ready: SKILL.md からテンプレ本文記入ガイドを CLI テンプレ (`templates/issue/{task,bug}.md`) へ集約
- #548 w-revise: `review-summary` を廃止し `review-findings` / `review-resolution` を新設、書式ガイドを CLI テンプレに集約
- #549 w-merge: Epic 進捗報告フォーマットを CLI テンプレ実体 (`templates/comment/{merge-diff,precede-notify}.md`) に集約

## 2. コマンド名の決まり

### ルール

コマンドの名前（`path`）は `<対象> <動詞>` の 2 語にする。MCP のツール名は、2 語をつないだ `<対象>_<動詞>` になる。`_` が 1 個だけなので、前が対象、後ろが動詞と読める。

- path は 2 語で、どちらの語も `^[a-z]+$` に合わせる。ハイフンと数字は使わない
- 1 語目は、グループの一覧にある語。2 語目は、動詞の語彙にある語
- 同じ対象を扱うコマンドは、同じ 1 語目に置く
- `pecot mcp` は COMMANDS に無い起動の語なので、決まりの対象外

### グループ

| グループ | 扱うもの |
|:---|:---|
| `project` | プロジェクトとの接続と設定ファイル |
| `board` | ボードの上の Issue の置き場所 |
| `issue` | Issue そのもの |
| `session` | 1 つの Issue の作業 |
| `pr` | PR そのもの |
| `release` | リリース |
| `tracker` | Tracker の Issue の書き直し |
| `worktree` | worktree |
| `branch` | リモートのブランチ |

境目は次のとおり。

- `project` は、どのプロジェクトにどうつなぐかを扱う。ボードの上の Issue には触らない
- `board` は、そのプロジェクトの上に何が載っているかを扱う。設定ファイルは書かない
- `session` は、1 つの Issue の作業の始まりから終わりまでを扱う（`start`・`show`・`restore`・`finish`）

### 動詞の語彙

- 読む
  - `list`: 複数を並べる
  - `search`: GitHub を探す
  - `show`: 1 件を出す
  - `get`: 設定の値を出す
  - `check`: 次の操作の前に確かめる
- 作る・消す
  - `create`・`delete`: GitHub のものを作る・消す
  - `add`・`remove`: 集まりへ出し入れする
  - `init`: 既にあるものを pecot で使える状態にする
- 設定
  - `set`・`unset`: キーの値を設定・解除する
  - `link`: リポをプロジェクトにつなぐ
  - `activate`: 使うプロジェクトを切り替える
- 作業の流れ
  - `start`・`restore`・`finish`: 作業の始まり・復元・終わり
  - `sync`: 判定や一覧に合わせて書き直す
  - `move`・`merge`: 列を移す・PR を取り込む
- Issue
  - `comment`・`reopen`・`block`・`unblock`

語彙に無い語を使うときは、先に `cli/src/commands/names.ts` の一覧に意味と一緒に足す。足さないと、テストが落ちる。

`quick` は語彙から外した。Issue の作成と作業の開始を 1 つのコマンドが行う動詞は置かない。作成は `issue create`（`freeform`）、作業の開始は `session start` が行う。

読む動詞（`list`・`search`・`show`・`get`・`check`）は、何も書き換えない。GitHub・ボード・ファイル・状態を書くコマンドは、読む動詞に置かず、作る・消す・設定・作業の流れの動詞に置く。

### 入力名の決まり

同じものを指す入力は、コマンドが違っても同じ名前にする。

| 指すもの | 入力名 | 例 |
|:---|:---|:---|
| Issue | `issue_ref` | `issue comment`・`session start`・`board move` |
| PR | `pr_ref` | `pr show`・`pr check` |
| リポ | `repo` | `branch delete`・`project link` |
| 操作するブランチ | `branch` | `session start`・`branch delete` |

- `base`・`head` は PR の両端の役割の名前なので、`branch` にしない。真偽値の `delete_branch` も変えない
- 古い名前で別名を作らない。改名したら、古い入力名の表（`cli/src/commands/renamed-commands.ts`）に足し、古い入力名は新しい名前を案内して止める
- 書き込むコマンド（effects に write か destructive を持つもの）は、入力 `dry_run`（CLI は `--dry-run`・`-n`）を持つ。入力の検証と読み取りは予行でも行い、書き込みの直前で `dry-run: would ...` の行を出して終わる

### 次の操作の案内

出力に次の操作を案内するときは、`pecot <グループ> <動詞>` の文字列を直に書かない。MCP で呼ぶエージェントは、`pecot` の行を打てない。
案内は、コマンドの path と入力のデータで持つ。文にするのは案内の関数で、置き場は `cli/src/domain/command-hint.ts` と `cli/src/commands/command-hint.ts`。

- CLI では `pecot project link o/r --develop-branch develop` の形で出る
- MCP では `project_link with repo: "o/r", develop_branch: "develop"` の形で出る
- 定義に無い path や入力名を渡すと、例外になる
- `cli/src/` の出力の文字列に `pecot <グループ>` の直書きが無いことは、`cli/tests/direct-hint-lint.test.ts` が確かめる
- `--help` の examples は、CLI だけに出るので `pecot ...` のまま書いてよい

### 確かめる場所

- `libs/interface-spec` の検証が、定義書（`interface/generated.json`）の全項目の名前を、最上位の `names` と比べる
  - `names` は、区切り・語の位置ごとの語彙・読むだけの動詞を持つ
  - 語彙を変えたときは、書き出し（`cli/scripts/export-interface.ts`）を回して `generated.json` を直す。直さないと `diffGenerated` が落ちる
  - pecot-visual と pecot-tools の定義書にも、同じ検証が掛かる
- `cli/src/commands/names.ts` の関数が、path の一覧から決まりに合わないものを理由つきで返す
- `cli/src/commands/tests/registry.test.ts` が、COMMANDS の全部を関数に当てて、違反が空であることを確かめる
- `cli/tests/interface/` のテストが、次の 2 つを確かめる
  - write か destructive の effects を持つ項目は `dry_run` を持つ
  - 対象ごとに使える入力名は 1 つだけ
- 名前を変えるときは、古い名前の案内の表（`cli/src/commands/renamed-commands.ts`）も直す。README には移行の手順を書かず、利用者が読む変更点は version plan に書く

## 3. 試験環境

GitHub に書き込む pecot の変更は、マージの前に、検証用のリポとボードで確かめる。このリポ（`pecotcraft/pecot`）の Issue・PR・ボードには、確かめで何も作らない。

### 試験環境の一覧

| 名前 | 中身 |
|:---|:---|
| このリポ | `pecotcraft/pecot`。ボードは Projects の 1 番。確かめでは書き込まない |
| 検証用のリポ | `pecotcraft/pecot-sandbox`。確かめで作る Issue・PR・ブランチを置く |
| 検証用のボード | `pecot sandbox`（Projects の 3 番）。書き込むボードはこれだけ |
| 検証用の clone | `.pecot/work/<Issue番号>/pecot-sandbox/`。MCP ツールや `pecot` を動かす作業ディレクトリ |

### 検証用の clone の作り方

検証用の clone は、作業ツリーとは別のディレクトリに作る。MCP ツールの引数でリポを切り替える形は使えないので、clone を作業ディレクトリにして動かす。

```bash
git clone https://github.com/pecotcraft/pecot-sandbox .pecot/work/<Issue番号>/pecot-sandbox
cd .pecot/work/<Issue番号>/pecot-sandbox
pecot project activate github.com_pecotcraft_pecot-sandbox_sandbox.json
```

2 つのセッションで同時に確かめるときは、clone を 2 つ作る。1 つの clone を共有すると、`session_start` の checkout がぶつかる。

直した pecot-workflow は、この clone で、次の「直した pecot-workflow を動かす」の手順で起こす。

### 直した pecot-workflow を動かす

検証用の clone を作業ディレクトリにして、クライアントに作業ツリーのプラグインを読ませる。

- `--plugin-dir` には、直した作業ツリーの絶対パスを渡す。別の checkout（base など）を渡すと、直しの入っていない版が動く。#454 で古い版が動いたのは、この形と同じ現れ方だった
- base で始めたセッションのまま、worktree の直しを確かめない
- clone で初めて起こすと、フォルダを信頼するかを聞かれる
  - Claude Code は `Yes, I trust this folder` を選ぶ。信頼は覚えられ、同じパスでは次から聞かれない
  - GitHub Copilot CLI は `Yes` を選ぶ。`remember this folder` の方は選ばない。`~/.copilot/settings.json` が変わるため

#### Claude Code

```bash
cd .pecot/work/<Issue番号>/pecot-sandbox
claude --plugin-dir <作業ツリーの絶対パス>/plugins/pecot-workflow plugin list --json
claude --plugin-dir <作業ツリーの絶対パス>/plugins/pecot-workflow
```

- 起こす前に、`plugin list --json` の `pecot-w@inline` の行を見る。`installPath` が作業ツリーを指すこと
- 起こした後に、`/mcp` を開く。`plugin:pecot-w:pecot-workflow` が 1 つだけあること
  - 2 つあるときは、入れてある pecot-w を `/plugin` で無効にしてから起こし直す。2 つ並ぶ場合は、手元では確かめていない（この環境の pecot-w はこのリポのスコープで入っており、clone では読まれない）

#### GitHub Copilot CLI

```bash
cd .pecot/work/<Issue番号>/pecot-sandbox
COPILOT_PLUGIN_DIR_ONLY=true copilot --plugin-dir <作業ツリーの絶対パス>/plugins/pecot-workflow
```

- `COPILOT_PLUGIN_DIR_ONLY=true` を付けると、入れてあるプラグインを読まず、`--plugin-dir` のものだけを読む
  - 付けないと、入れてある pecot-w と並んだとき、フックが両方の版で登録されて動く
  - pecot-v など、ほかのプラグインも読まれない
- 起こした後に、`/env` を開いて 2 つを見る
  - Skills の各行のパスが作業ツリーを指すこと
  - Hooks の sources は `pecot-w` だけであること
- エージェントに渡った本文は、応答では確かめにくい。本文を引用させても、モデルは断ることがある。`--log-level all --log-dir <ディレクトリ>` を付けて起こし、ログの `instructions` の中に、直した文を探す

#### 直しを反映させる

セッションの中で直したときは、次の操作で反映させる。

| 直したもの | Claude Code | GitHub Copilot CLI |
|:---|:---|:---|
| スキル | `/reload-plugins` | `/skills reload` |
| エージェント | `/reload-plugins` | 要らない。呼ぶたびに読み直す |
| フックのスクリプトの本文 | 要らない。次に起きたときから反映される | 要らない |
| MCP サーバ（`cli/src`） | `/mcp` で `plugin:pecot-w:pecot-workflow` を選び、Reconnect を選ぶ。その後に `/clear` する | `/mcp reload pecot-workflow` |
| `hooks.json` | `/reload-plugins` | セッションを終えて起こし直す。`/restart` では反映されない |
| `.mcp.json`・`mcp.json` | `/reload-plugins` | `/mcp reload` |

- MCP サーバを起こし直すと、`bin/pecot` が `cli/src` から build し直す
- Claude Code の `/reload-plugins` は、設定の変わらない MCP サーバを起こし直さない
- Claude Code の会話に読み込み済みのツール定義は、Reconnect の後も古いまま残る。そのため `/clear` で新しい会話にする
- `/clear` は会話を捨てる。確かめの途中の会話を残したいときは、セッションを始め直す

手元の版は、Claude Code 2.1.326・GitHub Copilot CLI 1.0.112。

### 確かめの前に設定を比べる

確かめの前に、このリポの作業ツリーで `plugins/pecot-workflow/scripts/sandbox/sandbox-diff.sh` を動かし、ずれが 0 件であることを見る。検証用の設定がこのリポとずれたままだと、確かめた結果がこのリポで再現しない。

```bash
plugins/pecot-workflow/scripts/sandbox/sandbox-diff.sh
```

- 比べるのは、ruleset・ボードの項目・`pecot-board-sync.yml` などである。何も書き換えない
- 終了コードは、ずれなしが 0、ずれありが 1、読めなかったときが 2
- ずれが出たら、検証用を直してから確かめる。比べない項目を足すときは、`sandbox-diff-items.json` と spec の表を同じ変更で直す

### 作るものの名前の形

確かめで作るものには、片付けの目印になる名前を付ける。`<乱数>` は `[0-9a-z]{4}` の 4 文字。

| 作るもの | 名前の形 |
|:---|:---|
| ブランチ | `cuj/<Issue番号>-<乱数>`。`session_start` が後ろに `/<検証用の Issue 番号>` を付ける形も含む |
| Issue・PR の題 | `[cuj <Issue番号>-<乱数>]` を含める。pecot が題の先頭に `[Task]` などを付けるので、先頭には置かない |
| リリースのタグ | `cuj/<Issue番号>-<乱数>-tgz`。`--latest=false` で作り、Latest の印を付けない |

`<Issue番号>` は、確かめを行っているこのリポの Issue の番号。

### 確かめで作ったものの片付け

確かめのあとは、`plugins/pecot-workflow/scripts/sandbox/sandbox-sweep.sh` で片付ける。対象は、名前の形に合う開いた PR・ブランチ・Issue・ボードのカード・リリース。

```bash
plugins/pecot-workflow/scripts/sandbox/sandbox-sweep.sh --issue <Issue番号> --dry-run
plugins/pecot-workflow/scripts/sandbox/sandbox-sweep.sh --issue <Issue番号>
```

- `--issue <番号>` は、その Issue の番号を持つものだけを片付ける。省くと、名前の形に合うものをすべて片付ける
- `--dry-run` は、片付けるものを出すだけで、何も書き換えない
- 書き換える先は検証用のリポとボードに固定。名前の形に合わないものと、検証用の `main`・設定のファイルには触らない
- 2 回続けて動かしても、2 回目は 0 件で終わる
- `sandbox-diff.sh` と `sandbox-sweep.sh` は、このリポの `.claude/settings.json` で承認なしに打てる。既定のモードの `claude -p` から打っても止まらない

### 配る自動化を確かめる

利用者へ配る `cli/templates/workflow/pecot-board-sync.yml` を直したときは、マージの前に、検証用の `.github/workflows/` に入れて起こす。
テンプレートは、npm に公開した `@pecot/workflow-mcp` を `npx` で取る。直した中身で動かすには、作業ツリーから作った tgz を取らせる。

検証用の main の workflow を書き換えるので、この確かめは 1 度に 1 人で行う。

1. 作業ツリーで、配布ツリーを作る。`<版>` は `plugins/pecot-workflow/.claude-plugin/plugin.json` の版

   ```bash
   OUT=<リポの外の、不在か空のディレクトリ>
   bash plugins/pecot-workflow/scripts/release/publish-mcp-dist.sh --dry-run --version=<版>-cuj.<Issue番号>.r<乱数> --out-dir="$OUT"
   ```

   - `--out-dir` は、実体のパスがリポの外になければ止まる
     - worktree では `.pecot/work/<Issue番号>/dist` を使える。`.pecot/work` の実体が base にあり、リポの外になるため
     - base とふつうの clone では、`.pecot/work` の実体がリポの中なので使えない。リポの外のディレクトリを渡す
   - 版の `-cuj.<Issue番号>.r<乱数>` は、`npx` が取った版を手順 3 の `--version` で見分けるため
     - `<乱数>` の前の `r` は、`0042` のような数字だけの `<乱数>` でも版を semver として有効にするため
2. `$OUT` で `npm pack --pack-destination <置き場>` を打つ。リポの中で打つと、ルートの devEngines で止まる
3. tgz を検証用のリリースに添え、URL を取る。その URL から `npx` が直した版を取れることを見る

   ```bash
   gh release create cuj/<Issue番号>-<乱数>-tgz <tgz> --latest=false --target main -R pecotcraft/pecot-sandbox
   gh api repos/pecotcraft/pecot-sandbox/releases/tags/cuj/<Issue番号>-<乱数>-tgz --jq '.assets[0].browser_download_url'
   npx -y --prefix=/ <URL> --version    # pecot version <版>-cuj.<Issue番号>.r<乱数> が出る
   ```

4. 作業ツリーのテンプレートを写し、`npx` に渡す `@pecot/workflow-mcp@latest` だけを、その URL に替える
5. 検証用の clone で、写しを入れる PR を出し、merge queue で入れる
   - `gh pr create` はフックが止めるので、`pecot issue create`・`pecot session start`・`pecot pr create`・`pecot pr merge` を使う
   - 題とブランチは「作るものの名前の形」に合わせる
   - `workflow_dispatch`・`pull_request_target`・`issues` は、既定のブランチの定義で動く。PR のブランチに置いただけでは、直した定義で動かない
6. PR・Issue を変えるか `gh workflow run pecot-board-sync.yml -R pecotcraft/pecot-sandbox` を打って起こし、次の 2 つを見る
   - 実行の `Sync the board` の step が、URL の `npx` の行で成功すること
   - 検証用の clone で `pecot board show` を打ち、`project.number` が 3 で、動かす見込みのカードの列か Status が変わったこと
7. 写しを、このリポの main の `.github/workflows/pecot-board-sync.yml` と同じ中身に戻す PR を入れる
   - 戻す先はテンプレートではない。`sandbox-diff.sh` は、このリポの `.github/workflows/` の写しと比べる。テンプレートとは `npx` の 1 行が違う
8. `sandbox-diff.sh` で「ずれは 0 件」を見てから、`sandbox-sweep.sh` でリリースを消す
   - 順を逆にすると、検証用の main の workflow が消えた URL を取りに行き、間の実行が落ちる

定期の起動は、検証用に届かない。検証用の写しは `schedule` を持たず、このリポの Lambda（`.github/board-sync/`）は `pecotcraft/pecot` だけを起こす。
検証用から Lambda に配送が届いても、このリポの workflow は起きない。`handler.mjs` がリポの ID を比べ、違う配送を捨てる。
2026-11-17 に、デプロイ済みの設定で確かめた。

### このリポだけの運用

次の運用は、このリポだけで動き、利用者へは配らない。検証用に、確かめる場所を作らない。

| 運用 | 今の確かめ方 |
|:---|:---|
| リリース（`release.yml`・`publish-npm.yml`） | `gh workflow run release.yml --ref main` の dry-run で案を見る。`publish-mcp-dist.sh --dry-run` で配布ツリーを作る。workflow の形は `.githooks/tests/test_release_workflow.py`・`test_publish_npm_workflow.py` |
| 依存の更新と脆弱性の通知（`dependabot-*.yml`・`security-alerts.yml`） | `.githooks/tests/test_dependabot_commit_workflow.py`。Tracker を作る `pecot tracker sync` は、検証用で流せる（「GitHub に書き込む処理の一覧」） |
| workflow を外から起こす仕組み（`.github/board-sync/` の Lambda と Scheduler） | `.github/board-sync/handler.test.mjs`（`.githooks/tests/test_board_sync.py` から動かす） |

プラグインのほかにも、利用者へ配るもの（workflow・Lambda など）ができたら、検証用に確かめる場所を作る。

### GitHub に書き込む処理の一覧

pecot-workflow の定義書（`interface/authored.yaml`）から、次の 2 つを漏れなく拾った表。

- `effects` の `target: github` で、`kind` が `write` か `destructive` の項目
- remote へ push する `target: git` の項目。`pr_restack` だけが `git push --force-with-lease` で push する。ほかの `git` の項目は、手元のブランチ・worktree だけを変える

MCP のツール名は、CLI のコマンドの 2 語を `_` でつないだ形。「流した結果」は、2026-11-17 に pecot 7.0.0 を検証用に流した結果。括弧の中の番号は、検証用のリポの Issue・PR の番号。

| MCP ツール | CLI のコマンド | 作るもの・変えるもの | 片付け方 | 流した結果 |
|:---|:---|:---|:---|:---|
| `board_add` | `pecot board add` | ボードのカードと Status | `sandbox-sweep.sh`（Issue のカードをアーカイブ） | 通った。外したカードを Ready に戻した（#215） |
| `board_move` | `pecot board move` | カードの Status | `sandbox-sweep.sh`（カードをアーカイブ） | 通った。backlog と ready に移した（#214） |
| `board_sync` | `pecot board sync` | カードの列と Status。新しい 20 件を超えた Archived のカードを削除 | 名前の形のものは `sandbox-sweep.sh`。削除は戻せない | 通った。動かすカードと消すカードは 0 件だった |
| `branch_delete` | `pecot branch delete` | リモートブランチの削除 | 不要（消す処理） | 通った。消すと、その head の PR を GitHub が閉じた（#219） |
| `issue_block` | `pecot issue block` | blocked-by・Issue の本文・カードの列 | `sandbox-sweep.sh`（Issue を閉じる） | 通った（#214、#225） |
| `issue_unblock` | `pecot issue unblock` | blocked-by の解除・Issue の本文・カードの列 | `sandbox-sweep.sh` | 通った（#214、#225） |
| `issue_comment` | `pecot issue comment` | Issue のコメント | Issue ごと `sandbox-sweep.sh` が閉じる。コメントは残る | 通った。`-m` で送るときは `-t` でテンプレートの種類を渡す（#214） |
| `issue_create` | `pecot issue create` | Issue・blocked-by・カード・sub-issue | `sandbox-sweep.sh`（題に `[cuj …]` を含める） | 通った（#210 ほか） |
| `issue_reopen` | `pecot issue reopen` | Issue を開き直す・カードのアーカイブを解く・`Status` の `Done` を消す | `sandbox-sweep.sh` | 通った。`Status` の `Done` を消し、後の `session start` でも Issue は開いたままだった（pecotcraft/pecot#536） |
| `pr_create` | `pecot pr create` | PR・スタックへの登録・カードの Status | `sandbox-sweep.sh`（PR を閉じる） | 通った（#211 ほか） |
| `pr_merge` | `pecot pr merge` | PR のマージか merge queue への投入 | マージ済みの PR は残り、commit は検証用の `main` に残る | 通った。merge queue で落ちた PR は queue から外れた（#211、#213） |
| `pr_restack` | `pecot pr restack` | 手元のブランチの rebase と、remote のブランチの置き換え（`git push --force-with-lease`） | `sandbox-sweep.sh`（ブランチを消す） | 通った。積んだ PR だけが対象で、積んでいない PR は遅れていても「up to date」になる（#219） |
| `project_create` | `pecot project create` | org のボードとフィールド | 手で片付ける。題に `[cuj <Issue番号>-<乱数>]` を入れて作り、`gh project delete <番号> --owner pecotcraft` で消す | 通った。作った後は、新しいボードが有効になるので、`project activate` で戻す |
| `project_init` | `pecot project init` | ボードのフィールドと選択肢 | 手で片付ける。題に `[cuj <Issue番号>-<乱数>]` を入れたボードで流し、`gh project delete` で消す | 通った。フィールドの無いボードを `gh project create` で作って流した |
| `project_link` | `pecot project link` | リポのプロジェクトへのつなぎ | 手で外す。`gh project unlink <番号> --owner pecotcraft --repo pecotcraft/pecot-sandbox` | 通った。外す手順も、この形で動いた |
| `release_create` | `pecot release create` | `v*` のリリースとタグ | 手で片付ける。作ったタグを `gh release delete <タグ> --cleanup-tag --yes -R pecotcraft/pecot-sandbox` で消す | 通った。版の節を書いた `CHANGELOG.md` を clone に一時に置いて流した |
| `release_merge` | `pecot release merge` | release の PR のマージと、head ブランチの削除 | 流せない。このリポは bypass で通す操作だが、bypass はこのリポだけの運用（FR-008）なので、検証用には足さない | 流せない |
| `session_start` | `pecot session start` | 紐づいたブランチ・カードの Status を `active` に | `sandbox-sweep.sh`（ブランチを消す） | 通った（#210 ほか） |
| `session_finish` | `pecot session finish` | Issue を閉じる・リモートの head ブランチを削除 | 不要（閉じる・消す処理）。カードは `sandbox-sweep.sh` がアーカイブ | 通った（#214） |
| `tracker_sync` | `pecot tracker sync` | Tracker の Issue（題に `[cuj …]` が付かない）・カード | 手で片付ける。作った Issue の番号を控え、`gh issue close <番号> -R pecotcraft/pecot-sandbox` で閉じる | 通った。対象が 0 件で、Tracker を作らずに終わった |
| （MCP ツールなし） | `pecot-board-sync.yml`（利用者へ配る workflow） | PR・Issue の変化で `board_sync` を動かし、カードの列と Status を直す | 検証用の `.github/workflows/` に入れる。`sandbox-diff.sh` がこのリポの `main` と中身を比べる | 動いた。PR・Issue の変化で毎回起き、成功した（run 43999921365 ほか）。写しはこのリポの `main` にそろえた（#209）。直した中身の tgz（7.0.0-cuj.477.6dm3）を取る写しでは、前提を `gh issue close` で閉じると、待つ側の Status を Needs Attention にした（run 44014436472、#243） |

名前の形に合わないものを作る処理は、`sandbox-sweep.sh` では片付かない。表の「手で片付ける」の手順で消す。

### 書き込む前の 3 つの決まり

1. 環境に `PECOT_GITHUB_COM_TOKEN`・`GITHUB_COM_TOKEN` が無く、手元で `gh` に認証していれば、`.pecot/config/.env` は置かなくてよい。pecot は、この 2 つの変数が無いと `gh auth token` を使う
   - 別のトークンで書き込むときは、検証用の clone の `.pecot/config/.env` に `PECOT_GITHUB_COM_TOKEN=<トークン>` の 1 行を書く
   - そのときは 2 つの変数を環境から外す。`.env` の行は、既にある環境変数を上書きしない
2. 書き込む前に、毎回 `board_show` を呼ぶ。書き込む先がボード `pecot sandbox` であることを見てから、書き込む処理を動かす
   - `board_show` はボードの題を出さない。`project` の `number` が、上の「試験環境の一覧」の検証用のボードの番号と同じことを見る
3. このリポの ruleset・ボード・`pecot-board-sync.yml` の決まりを変えるときは、検証用を先に変える。順を逆にすると、検証用が古い決まりのままで、確かめた結果がこのリポで再現しない
