---
paths:
  - "**/CHANGELOG.md"
  - ".nx/version-plans/**"
---

# CHANGELOG / version-plans を編集する前に

このリポは **nx release（`nx.json` の `versionPlans: true`）** で CHANGELOG を生成します。

## CHANGELOG.md は手動編集しない

対象は次の 4 つです。

- `plugins/pecot-workflow/CHANGELOG.md`
- `plugins/pecot-visual/CHANGELOG.md`
- `plugins/pecot-tools/CHANGELOG.md`
- `libs/text-rules/CHANGELOG.md`

これらはリリース時に nx が version-plans から自動生成・追記します。手で編集してもリリース時に
上書きされる可能性があるため、変更を入れたい時は CHANGELOG ではなく
`.nx/version-plans/` に新規ファイルを作ります。

## version-plan の書式

`.nx/version-plans/<issue-or-pr-number>-<slug>.md` を新規作成し、frontmatter で
**プロジェクト名 → bump 種別** を 1 行ずつ書きます。本文がそのまま CHANGELOG entry に
なります。

```markdown
---
pecot-visual: patch
---

dom-to-pptx 1.1.7 の Fractional Font Precision 修正で sz が +5〜13.3% 増加し、
固定 cx の footer / agenda heading で折り返しが発生していた問題を、
テンプレ側 shape 寸法を 1.1.7 sz に合わせて拡張する形で吸収する。
```

プロジェクト名は `nx.json` の release group 名に対応します。`pecot-workflow` / `pecot-visual` / `pecot-tools` / `text-rules` のいずれかです。
複数プロジェクトを同時に bump する時は frontmatter に複数行書きます。

## bump 種別の判断

- `patch`: バグ修正・内部リファクタ・互換性のある内部改善
- `minor`: 後方互換のある機能追加
- `major`: 互換性破壊。**未使用機能の削除は major にしない**（実害が無い限り patch）

迷ったら直近の `.nx/version-plans/*.md` で似た規模の変更がどう判定されているか
確認してから決めます。
