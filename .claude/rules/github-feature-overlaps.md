---
paths:
  - "plugins/pecot-workflow/cli/src/commands/project-sync.ts"
  - "plugins/pecot-workflow/cli/src/domain/board-move.ts"
  - "plugins/pecot-workflow/cli/src/domain/config.ts"
  - "plugins/pecot-workflow/cli/src/commands/board-view.ts"
  - "plugins/pecot-workflow/cli/src/commands/issue-shared.ts"
  - "plugins/pecot-workflow/cli/src/domain/issue-kind.ts"
  - "plugins/pecot-workflow/cli/src/domain/issue-order.ts"
  - "plugins/pecot-workflow/cli/templates/issue/**"
  - "plugins/pecot-workflow/cli/templates/comment/**"
  - "plugins/pecot-workflow/cli/templates/pr/**"
  - "plugins/pecot-workflow/interface/issue-coverage.yaml"
---

# GitHub の機能と役割の重なる、pecot 独自の仕組み

次の仕組みは、GitHub の機能と役割が重なりますが、pecot が意図して独自で持っています。標準の機能へ置き換える前に、この表の理由がまだ当てはまるかを確かめます。

| 仕組み | 重なる GitHub の機能 | 残す理由 |
|:---|:---|:---|
| 進行の欄 `pecot-status`（`Status` は札に使う） | 既定の `Status` の欄 | 既定の `Status` は進み具合の軸で、着手の可否を混ぜない（`specs/024-issue-readiness-stacked-prs/spec.md` の Clarifications、2026-11-12 に利用者が決定） |
| `Blocked` の列 | 依存を持つ Issue に出る Blocked の印 | 組み込みの自動化は、ほかの Issue の状態を条件にできず、進行の欄を動かせない。印はそのまま出し、列で着手の可否を示す（`specs/024-issue-readiness-stacked-prs/research.md` の R10） |
| `Archived` の列と、board-sync の action が最新の 20 件を超えた分をボードから消す処理 | 項目のアーカイブ、自動でアーカイブする組み込みの自動化 | ボードは Issue が増えすぎると動作が非常に重くなるので、定期的に掃けさせるのが必須（#709 で利用者が決定） |
| 題の接頭辞 `[Task]`・`[Epic]`・`[Tracker]`・`[Bug]` | Issue type | Issue type を使えなかった頃からの仕組みで、Issue type の無い個人のリポにも配るために残す（#709 で利用者が決定） |
| 題の通し番号 `#<Epic>-<番号>:` | sub-issue の親と並び | sub-issue の並びは親の Issue の画面にしか出ず、ボードの項目や PR の題では順番を読めない（#709 で利用者が決定） |
| `pecot-template://` の雛形 | リポの Issue テンプレート | リポの Issue テンプレートは、GitHub の画面で Issue を作るときの入力欄にだけ使われ、API で書く本文を確かめられない。コメントと PR の本文にあたる機能も無い（#709 で利用者が決定） |

## 独自の仕組みを足すとき

GitHub に同じ役割の機能があるのに独自の仕組みを足すときは、利用者に理由を示して同意を得てから、この表に行を足します。仕組みを消すか、標準の機能に置き換えたときは、その行を消します。
