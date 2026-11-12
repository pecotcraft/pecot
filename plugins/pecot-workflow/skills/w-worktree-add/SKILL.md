---
name: w-worktree-add
description: |
  ワークツリーを作成します。
  Use when the user wants to create a new git worktree via the pecot CLI — single-repo only (cwd / repo named in the request).
  Do NOT use for removal (use w-worktree-remove).
when_to_use: "ワークツリーを作りたい、並行作業用の作業ディレクトリを増やしたい"
---

# ワークツリー作成

`worktree_add` でワークツリーを作る。devcontainer 内で実行すること（プロジェクトの devcontainer が整えるマウント構造に依存）。

main WT は `<project-root>/base/<repo>/`、新 WT は `<project-root>/<wtN>/<リポ名>/` に作られる。セット名 `wtN` は常に自動採番（手動指定は不可、対象リポが未参加の最小 `wtN` に入る）。

実行にはアクティブな pecot のプロジェクト設定（`~/.pecot/config/projects/.active`）と、対象リポがその `repositories[]` に登録されていることが必要。

## スコープ

対象リポは依頼で示された 1 つに限定する。project に他リポが登録されていても勝手に init / add しない。

## 手順

### Step 1: （初回のみ）ワークツリー設定を用意

対象リポの main WT に `.pecot/config/worktree-config.json` と `.pecot/config/.worktreeignore` の両方が必要。どちらかが欠けていると `worktree_add` は `exit code: 1` で失敗する。
init は両ファイルを同時に生成する。`worktree_init` を `directory: "<project-root>/base/<repo>"` で呼ぶ。

生成される `worktree-config.json` の `links[]` を編集する（symlink 不要なら空でよい）。

- `path` … サブ WT 側リポ内の相対パス
- `target_repo` … `<project-root>/base/` 直下のターゲットリポ名。共有 3 リンク（`CLAUDE.local.md`・`.env`・`.claude/settings.local.json`）には、init が aggregation_repo のリポ名を入れる。未設定なら自リポ名を入れる
- `target_path` … `base/<target_repo>/` 配下の相対パス

生成される `.worktreeignore` は、Git 管理外ファイルをサブ WT にコピーする際の除外パターンを定義する。
記法は、`.gitignore` と同じ pathspec gitwildmatch 。
リポ固有のビルドキャッシュなど、追加で除外したいディレクトリがあれば追記する。

WT 作成直後に依存インストール等を実行したい場合は、`worktree-config.json` のトップレベルに `setup_command` を追記する（shell 経由で実行）。

```json
{
  "version": 3,
  "setup_command": "uv sync",
  "links": []
}
```

`worktree_add` に `setup: "<cmd>"` を渡した場合はそちらが優先される（config の `setup_command` は無視）。setup が非ゼロ終了または時間切れでも、WT 作成自体は成功扱い（`exit code` の行が付かない）になる。
失敗のときだけ `warning: setup command ...` の行が出て、コマンドの stdout/stderr が続く。成功のときは何も表示されない。

### Step 2: add を呼ぶ

対象リポの main WT を指して、`worktree_add` を `directory: "<project-root>/base/<repo>"` で呼ぶ。ツールは作業ディレクトリを `directory` で受けるので、`cd` しない。

入力は `worktree_add` の入力の定義で確かめる。既存ブランチ衝突時は `allow_existing_branch: true` で再利用可能。

採番されたセット名 `<wtN>` で、`<project-root>/<wtN>/<リポ名>/` に WT が作られる。
symlink は add 時に自動で張られる（`.pecot/config/worktree-config.json` がある場合）。

### Step 3: 既存サブ WT に symlink 設定を反映する

`.pecot/config/worktree-config.json` を後から編集した場合、既存のサブ WT へ反映するには、main WT を指す。
`worktree_link` を `directory: "<project-root>/base/<repo>"`・`all: true` で呼ぶ。

リアルファイルが置かれていて衝突する場合は `force: true`。
