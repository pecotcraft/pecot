---
pecot-workflow: minor
pecot-visual: patch
---

<!--
このテンプレートをコピーして `.nx/version-plans/<番号>-<slug>.md` として保存する。
  - <番号>: 紐づく Issue 番号を優先、Issue が無い場合は PR 番号で可
  - <slug>: kebab-case の英字＋数字（連続ハイフン・末尾ハイフン・大文字不可）
  - 例: 227-version-plan-naming.md

コピー元は `.nx/nx-release/version-plan-template.md`（`.nx/version-plans/` の外）。
Nx が `.nx/version-plans/` 配下の全ファイルを plan として読むため、
テンプレート自身はそこに置かない。

frontmatter: キーは `nx.json` の `release.groups` の group 名（`pecot-workflow` / `pecot-visual` / `pecot-tools` / `text-rules`）、
値は semver ReleaseType (`patch` / `minor` / `major` 等)。group 名以外をキーにしても gate は
宣言として認識しない。bump 不要な group はキーごと省略する。

本文フォーマット（pre-commit hook `check-version-plan-format` で自動検証）:
  - **これは CHANGELOG に転記される 1 bullet。WHAT のみ書く。WHY（背景・動機）と
    HOW（根本原因・実装詳細・影響範囲の説明・削除対象の内訳）は PR description
    と commit message に書く**
  - 1 段落の短文（空行なし）
  - 非空行数 ≤ 3
  - 総文字数 ≤ 200
  - 各行 ≤ 100 chars（Nx が行末に PR refs を自動付与するので余白を残す）
  - '- ' 箇条書き禁止（Nx の bullet とネストして崩れる）
  - '#' 見出し禁止（Nx が bump 種別から自動付与）
  - 重要キーワード（追加機能名 / 削除対象 / 影響範囲など）は `**...**` で太字推奨
    （CHANGELOG 上で要点が埋もれないため）

複数の独立した変更を 1 PR で出す場合や、機能追加 + バグ修正の混在は
plan を複数本に分ける（例: `227-feature-x.md` / `228-fix-y.md`）。
-->

pecot-pr スキルに **PR 説明の自動生成** を追加。
