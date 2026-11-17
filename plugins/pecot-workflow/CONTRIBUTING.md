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

直した pecot-workflow を動かすときは、作業ツリーの絶対パスを渡す。

```bash
claude --plugin-dir <作業ツリーの絶対パス>/plugins/pecot-workflow
```

### 確かめの前に設定を比べる

確かめの前に、このリポの作業ツリーで `.githooks/scripts/sandbox-diff.sh` を動かし、ずれが 0 件であることを見る。検証用の設定がこのリポとずれたままだと、確かめた結果がこのリポで再現しない。

```bash
.githooks/scripts/sandbox-diff.sh
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
| リリースのタグ | `cuj/<Issue番号>-<乱数>-tgz` |

`<Issue番号>` は、確かめを行っているこのリポの Issue の番号。

### 確かめで作ったものの片付け

確かめのあとは、`.githooks/scripts/sandbox-sweep.sh` で片付ける。対象は、名前の形に合う開いた PR・ブランチ・Issue・ボードのカード・リリース。

```bash
.githooks/scripts/sandbox-sweep.sh --issue <Issue番号> --dry-run
.githooks/scripts/sandbox-sweep.sh --issue <Issue番号>
```

- `--issue <番号>` は、その Issue の番号を持つものだけを片付ける。省くと、名前の形に合うものをすべて片付ける
- `--dry-run` は、片付けるものを出すだけで、何も書き換えない
- 書き換える先は検証用のリポとボードに固定。名前の形に合わないものと、検証用の `main`・設定のファイルには触らない
- 2 回続けて動かしても、2 回目は 0 件で終わる

### GitHub に書き込む処理の一覧

pecot-workflow の定義書（`interface/authored.yaml`）から、次の 2 つを漏れなく拾った表。

- `effects` の `target: github` で、`kind` が `write` か `destructive` の項目
- remote へ push する `target: git` の項目。`pr_restack` だけが `git push --force-with-lease` で push する。ほかの `git` の項目は、手元のブランチ・worktree だけを変える

MCP のツール名は、CLI のコマンドの 2 語を `_` でつないだ形。「流した結果」は、検証用で最後まで流してから埋める。「未」は、まだ流していないことを表す。

| MCP ツール | CLI のコマンド | 作るもの・変えるもの | 片付け方 | 流した結果 |
|:---|:---|:---|:---|:---|
| `board_add` | `pecot board add` | ボードのカードと Status | `sandbox-sweep.sh`（Issue のカードをアーカイブ） | 未 |
| `board_move` | `pecot board move` | カードの Status | `sandbox-sweep.sh`（カードをアーカイブ） | 未 |
| `board_sync` | `pecot board sync` | カードの列と Status。新しい 20 件を超えた Archived のカードを削除 | 名前の形のものは `sandbox-sweep.sh`。削除は戻せない | 未 |
| `branch_delete` | `pecot branch delete` | リモートブランチの削除 | 不要（消す処理） | 未 |
| `issue_block` | `pecot issue block` | blocked-by・Issue の本文・カードの列 | `sandbox-sweep.sh`（Issue を閉じる） | 未 |
| `issue_unblock` | `pecot issue unblock` | blocked-by の解除・Issue の本文・カードの列 | `sandbox-sweep.sh` | 未 |
| `issue_comment` | `pecot issue comment` | Issue のコメント | Issue ごと `sandbox-sweep.sh` が閉じる。コメントは残る | 未 |
| `issue_create` | `pecot issue create` | Issue・blocked-by・カード・sub-issue | `sandbox-sweep.sh`（題に `[cuj …]` を含める） | 未 |
| `issue_reopen` | `pecot issue reopen` | Issue を開き直す・カードのアーカイブを解く | `sandbox-sweep.sh` | 未 |
| `pr_create` | `pecot pr create` | PR・スタックへの登録・カードの Status | `sandbox-sweep.sh`（PR を閉じる） | 未 |
| `pr_merge` | `pecot pr merge` | PR のマージか merge queue への投入 | マージ済みの PR は残り、commit は検証用の `main` に残る | 未 |
| `pr_restack` | `pecot pr restack` | 手元のブランチの rebase と、remote のブランチの置き換え（`git push --force-with-lease`） | `sandbox-sweep.sh`（ブランチを消す） | 未 |
| `project_create` | `pecot project create` | org のボードとフィールド | 手で片付ける。題に `[cuj <Issue番号>-<乱数>]` を入れて作り、`gh project delete <番号> --owner pecotcraft` で消す | 未 |
| `project_init` | `pecot project init` | ボードのフィールドと選択肢 | 手で片付ける。題に `[cuj <Issue番号>-<乱数>]` を入れたボードで流し、`gh project delete` で消す | 未 |
| `project_link` | `pecot project link` | リポのプロジェクトへのつなぎ | 手で外す。`gh project unlink <番号> --owner pecotcraft --repo pecotcraft/pecot-sandbox` | 未 |
| `release_create` | `pecot release create` | `v*` のリリースとタグ | 手で片付ける。作ったタグを `gh release delete <タグ> --cleanup-tag --yes -R pecotcraft/pecot-sandbox` で消す | 未 |
| `release_merge` | `pecot release merge` | release の PR のマージと、head ブランチの削除 | 流せない。このリポは bypass で通す操作だが、bypass はこのリポだけの運用（FR-008）なので、検証用には足さない | 流せない |
| `session_start` | `pecot session start` | 紐づいたブランチ・カードの Status を `active` に | `sandbox-sweep.sh`（ブランチを消す） | 未 |
| `session_finish` | `pecot session finish` | Issue を閉じる・リモートの head ブランチを削除 | 不要（閉じる・消す処理）。カードは `sandbox-sweep.sh` がアーカイブ | 未 |
| `tracker_sync` | `pecot tracker sync` | Tracker の Issue（題に `[cuj …]` が付かない）・カード | 手で片付ける。作った Issue の番号を控え、`gh issue close <番号> -R pecotcraft/pecot-sandbox` で閉じる | 未 |
| （MCP ツールなし） | `pecot-board-sync.yml`（利用者へ配る workflow） | PR・Issue の変化で `board_sync` を動かし、カードの列と Status を直す | 検証用の `.github/workflows/` に入れる。`sandbox-diff.sh` がこのリポの `main` と中身を比べる | 未 |

名前の形に合わないものを作る処理は、`sandbox-sweep.sh` では片付かない。表の「手で片付ける」の手順で消す。

### 書き込む前の 3 つの決まり

1. 検証用の clone に `.pecot/config/.env` を置く。GitHub のトークンを `PECOT_GITHUB_COM_TOKEN=<トークン>` の 1 行で書く。手元の `gh` の認証と同じ人のトークンでよい
2. 書き込む前に、毎回 `board_show` を呼ぶ。書き込む先がボード `pecot sandbox` であることを見てから、書き込む処理を動かす
3. このリポの ruleset・ボード・`pecot-board-sync.yml` の決まりを変えるときは、検証用を先に変える。順を逆にすると、検証用が古い決まりのままで、確かめた結果がこのリポで再現しない
