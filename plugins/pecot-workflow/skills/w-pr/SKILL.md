---
name: w-pr
description: |
  PRを作成しタイトル・説明を自動生成します。
  Use when the user wants to create a pull request for the current branch — auto-generates title/description from commits and diff. Triggers: "create PR", "submit for review".
  Does not merge PRs (use w-merge).
allowed-tools: Bash(*/bin/pecot pr preflight:*), Bash(*/bin/pecot pr create:*), Bash(git push:*), Bash(git checkout:*), Bash(git branch:*), Bash(git worktree list:*), Bash(git fetch:*), Bash(git pull:*), Bash(mkdir:*), Bash(touch:*), Bash(pecot pr:*)
when_to_use: "PR を作りたい、レビューに出したい、プルリクエストの説明文を作ってほしい"
---

# プルリクエスト作成

## pecot CLI ランチャー

pecot CLI は実行環境ごとにランチャーを変数化してから使う。

Claude Code:

```bash
PECOT=pecot
```

GitHub Copilot CLI は shell tool の PATH にプラグイン `bin/` が入らないため、最初からインストール済み wrapper を使う。

```bash
PECOT="$HOME/.copilot/installed-plugins/pecot/pecot-w/bin/pecot"
```

以降の pecot CLI コマンド例は必ず `$PECOT ...` として実行する。

現在のブランチの変更内容を分析し、変更内容に合ったタイトルと説明でプルリクエストを作成します。

## 手順

### Step 1: 事前確認スクリプトを実行

```bash
$PECOT pr preflight -D .
```

exit 1 なら出力を見て解決し、再実行してから次へ進む。

### Step 2: 変更内容の確認とコミット

1. コミットが必要な場合は自動的にコミットする
   - ステージング済みだがコミットされていない場合、プロジェクトのコミット規約に沿ってコミット（既存履歴 `git log` を参照）
   - コミットメッセージは git diff から生成
   - **不要な確認はしない**（即座にコミット実行）

2. 変更内容を確認する
   - 扱いに困る変更（意図不明、関係なさそう等）があればユーザーに確認
   - 明確な問題がない場合は確認不要

### Step 3: PR作成

```bash
# 1. テンプレート準備
$PECOT pr create --prepare
# 2. 出力されたファイルを編集
#    - 冒頭の <!-- 読者: / 書き方: / フィールド: --> ガイドコメントに従って YAML フロントマターと本文を記述
# 3. 投稿
$PECOT pr create <ファイルパス>
```

feature PR の `base` は `--prepare` が config 由来で自動設定する。2ブランチモードのリポは
開発ブランチ（`develop-aist` 等）、単一ブランチモード（`develop` == `release` / trunk-based）の
リポは `main`。自動設定された `base` を書き換えない。

スクリーンショットは、本文から `![説明](./画像のファイル名)` で参照し、PR を作った後に gh で載せる。
gh v2.99.0 以上が要る。GHES のリポでは使えない。

```bash
gh pr view <PR番号> --json body -q .body > <画像のディレクトリ>/body.md
gh pr edit <PR番号> --body-file <画像のディレクトリ>/body.md --attach <画像のパス>
```

`--attach` は画像ごとに繰り返す。本文の画像のパスは、アップロード後の URL に書き換わる。

下書きの文章規則は、Claude Code で pecot-visual を入れた環境なら、下書きを Write / Edit した直後に確かめられる。
違反があると `[text-lint] Writing-rule violations in` で始まる通知が返る。指摘の行の文を書き直す。
下書きは書き込みで止まらず、投稿の CLI も文面を確かめない。投稿前に直す。何も返らないことは、違反が無いことを意味しない。
`[text-lint] Not checked` は、確認していないという通知を表す。
違反が多いと先頭 100 行だけが返る。直して保存し直すと、残りが返る。
関門（pre-commit と commit-msg）を入れたリポでは、commit する文書とコミットメッセージが止まる。
出力の形はリポで異なる。例は `<path>:<line>:<col> <ruleId> <message>` と、ファイル名の行に続く `行:列 error メッセージ 規則名` の 2 形がある。
どちらも、指摘された行の文を直す。
規則・除外は変えない。無効化コメントと `--no-verify` にも触れない。

### Closing Issue キーワードと Epic

- `pr create --prepare` 実行時、テンプレの `Closes #` には active タスク番号が自動で埋め込まれる
- 自動埋め込みの番号を書き換えない。特に Epic 番号 (sub-issue を持つ親 Issue) を書かない
- ブランチ名末尾の `<num>` も sub-issue 番号にする
- `pecot pr merge` は Issue Type=Epic / `sub-issues > 0` の Issue を自動でクローズ対象から除外する（保険）
- 既知制約: Issue Type 未設定かつ sub-issue 0 件の Epic は判定不能

PR作成後、レビュー対応は `/pecot-w:w-revise`、マージは `/pecot-w:w-merge` を使用する。
