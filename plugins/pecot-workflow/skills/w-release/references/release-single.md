# 単一リポのリリース

1 リポ = 1 バージョン = 1 CHANGELOG の構成。タグ形式は `v<ver>`。

## バージョン決定基準

- **patch** (`X.Y.Z → X.Y.Z+1`): バグ修正のみ、API 変更なし
- **minor** (`X.Y.Z → X.Y+1.0`): 後方互換の機能追加
- **major** (`X.Y.Z → X+1.0.0`): 破壊的変更

## 手順

### 1. 対象確認

```bash
pecot project info
```

対象リポの `develop` branch と `release` branch を控える。リリースバージョンを `<ver>` と表記。

### 2. bump 種別のユーザー確認

`<ver>` を確定する前に、ユーザーへ以下を提示して明示的承認を得る。
承認を得るまで Step 3 以降（CHANGELOG 編集・docs PR・`pecot release preflight`・
`pecot release create` 等）には進まない。

提示項目:

- 現バージョン（直近タグ `v<前バージョン>`）→ 新バージョン `<ver>`
- 想定 bump 種別（`patch` / `minor` / `major`）
- 判断根拠: 上記「バージョン決定基準」のどれに該当するか
  （`git log v<前バージョン>..origin/<develop> --oneline` で拾った主要変更を要約）

確認観点:

- 「未使用機能の削除」「内部のみの変更」「ドキュメント追加のみ」など、外部影響が無い変更を `major` として扱っていないか
- 後方互換のある追加が `major` になっていないか
- バグ修正のみのはずが `minor` 以上になっていないか

参考事例（#205）は次のとおり。

- 機能削除を `major` で扱ったまま流し、`1.0.0 → 2.0.0` に過剰 bump した例がある。
  「削除」だからといって自動的に破壊的変更ではない（未使用・内部限定なら patch が妥当）

違和感があれば `<ver>` を選び直して本ステップをやり直す。
ユーザーから「OK」「進めて」等の明示承認を得て初めて Step 3 へ進む。

### 3. CHANGELOG 準備

#### 3-1. docs ブランチ作成

```bash
git fetch origin
git checkout -b docs/changelog-v<ver> origin/<develop>
```

#### 3-2. CHANGELOG.md 編集

前回タグ `v<前バージョン>` からの commit ログを集約してリリースノートを書く。

```bash
git log v<前バージョン>..origin/<develop> --oneline
```

`CHANGELOG.md`（または `Repository.changelog_file` が指すパス）の `[Unreleased]` の下に以下を追加:

```markdown
## [<ver>] - YYYY-MM-DD

### 追加
- ...

### 変更
- ...

### 修正
- ...
```

ファイル末尾の `[Unreleased]` / `[<ver>]` リンク定義も更新する。

#### 3-3. リポ固有の version file 更新

`plugin.json` / `package.json` / `pyproject.toml` 等のうち、CHANGELOG とバージョンの整合が必要なものは、合わせて更新する。
リポ側 pre-commit フックが強制するので、エラーに従えばよい。

#### 3-4. docs PR 作成・merge

```bash
git add <編集したファイル>
git commit -m "docs(changelog): <ver> リリースノートを追加"
git push -u origin docs/changelog-v<ver>

pecot pr create \
  --no-issue-ref \
  -r <owner>/<repo> \
  -t "docs(changelog): <ver> リリースノートを追加" \
  --screenshot "CHANGELOG の追記だけで、画面・生成する Markdown・CLI の出力は変わらない" \
  -m "## Summary

CHANGELOG.md に <ver> のリリースノートを追加した。

## Changes

なし

## Verified

- CHANGELOG.md に <ver> の節があることを確かめた

## Risks

なし" \
  -b <develop>

gh pr merge <PR番号> --repo <owner>/<repo> --squash
pecot pr cleanup <owner>/<repo>/<PR番号> --delete-branch
```

#### 3-5. develop 最新化

`<develop>` が checkout されている worktree に移動する。

```bash
git pull --ff-only origin <develop>
```

### 4. プリフライト

```bash
pecot release preflight <ver>
```

Dependabot の open の alert は警告を出すだけで止めない。
止めるのは code scanning・secret scanning の open の alert で、解消（fixed）か理由付きの dismiss で 0 件にしてから再実行する。
扱いは [release-nx.md](release-nx.md) の preflight の説明と同じ。

### 5. リリース PR 作成

```bash
pecot pr create --prepare --template release
```

下書きファイルを編集:

- `repository: <owner>/<repo>`
- `head: <develop>`
- `title: "release: v<ver>"`
- 本文: release 雛形の 4 節（Summary / Changes / Migration / Verified）を
  すべて埋める（1 つでも欠けると投稿時検証で弾かれる）。Changes には `CHANGELOG.md` の
  `## [<ver>]` セクションを転記

```bash
pecot pr create --template release <ファイルパス>
```

### 6. リリース PR マージ

```bash
pecot release merge <owner>/<repo>/<PR番号>
```

### 7. タグ + GitHub Release

```bash
pecot release create <ver>
```

### 8. 完了報告

タグ名 `v<ver>`、GitHub Release URL、リリース PR URL を報告して終了。
