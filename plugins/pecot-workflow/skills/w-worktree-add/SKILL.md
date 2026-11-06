---
name: w-worktree-add
description: |
  ワークツリーを作成します。
  Use when the user wants to create a new git worktree via the pecot CLI — single-repo only (cwd / repo named in the request).
  Do NOT use for removal (use w-worktree-remove).
when_to_use: "ワークツリーを作りたい、並行作業用の作業ディレクトリを増やしたい"
---

# ワークツリー作成

`pecot worktree add` でワークツリーを作る。devcontainer 内で実行すること（プロジェクトの devcontainer が整えるマウント構造に依存）。

main WT は `<project-root>/base/<repo>/`、新 WT は `<project-root>/<wtN>/<リポ名>/` に作られる。セット名 `wtN` は常に自動採番（手動指定は不可、対象リポが未参加の最小 `wtN` に入る）。

実行にはアクティブな pecot project 設定（`~/.pecot/config/projects/.active`）と、対象リポがその `repositories[]` に登録されていることが必要。

## スコープ

対象リポは依頼で示された 1 つに限定する。project に他リポが登録されていても勝手に init / add しない。

## 手順

### Step 1: （初回のみ）ワークツリー設定を用意

対象リポの main WT に `.pecot/config/worktree-config.json` と `.pecot/config/.worktreeignore` の両方が必要。どちらかが欠けていると `pecot worktree add` は exit 1 で失敗する。init は両ファイルを同時に生成する。

```bash
pecot worktree init -D <project-root>/base/<repo>
```

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

CLI で `--setup "<cmd>"` を渡した場合はそちらが優先される（config の `setup_command` は無視）。setup が非ゼロ終了しても WT 作成自体は成功扱い（exit 0）で、stdout/stderr が結果出力に表示される。

### Step 2: add を叩く

対象リポの main WT で実行:

```bash
cd <project-root>/base/<repo>
pecot worktree add -D .
```

オプションは `pecot worktree add --help`。既存ブランチ衝突時は `--allow-existing-branch` で再利用可能。

採番されたセット名 `<wtN>` で、`<project-root>/<wtN>/<リポ名>/` に WT が作られる。
symlink は add 時に自動で張られる（`.pecot/config/worktree-config.json` がある場合）。

### Step 3: 既存サブ WT に symlink 設定を反映する

`.pecot/config/worktree-config.json` を後から編集した場合、既存のサブ WT へ反映するには、main WT から次を実行する。

```bash
cd <project-root>/base/<repo>
pecot worktree link -D . --all
```

リアルファイルが置かれていて衝突する場合は `--force`。
