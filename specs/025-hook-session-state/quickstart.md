# Quickstart: pecot-workflow のフックの棚卸しと状態の持ち方を確かめる

**Feature**: [spec.md](spec.md) | **Contracts**: [hook-behavior.md](contracts/hook-behavior.md)・[work-target.md](contracts/work-target.md)

## 前提

- このリポの worktree で、`plugins/pecot-workflow` を読み込んだ Claude Code を使う
- 手元のテストは、変えたファイルに絞って動かす（CLAUDE.md の決まり）

## 1. 単体のテスト

契約の表の行を、1 つずつテストで確かめる。

```bash
# フック（hook 入力の JSON を各スクリプトに流す）
pnpm -C plugins/pecot-workflow/cli vitest run tests/hooks/post-exit-plan-mode.test.ts

# 作業中の Issue を求める規則
pnpm -C plugins/pecot-workflow/cli vitest run src/domain/tests/branch-name.test.ts

# MCP ツールの入力と出力
pnpm -C plugins/pecot-workflow/cli vitest run tests/interface/create-branch.test.ts
```

期待: 2 つの契約の表の行がすべて通る。sample・README・スクリプトの同期のテストと、定義書の検証も通る。

## 2. 承認と注意が出ないことを確かめる

1. スラッシュコマンドを使わずに「この変更の PR を作って」と頼む。期待: プラグインの承認の確認が出ない
2. `gh pr merge` を実行させる。期待: プラグインの承認の確認が出ない
3. `/pecot-w:w-quick` を打つ。期待: 決まりの 3 行の注意が会話に足されない

## 3. スキルの frontmatter のフックを実機で確かめる

1. 同じ worktree で、端末を 2 つ開いて Claude Code を起動する（セッション A・B）
2. A で `/pecot-w:w-quick` を打ち、計画を承認する。期待: 計画の更新の案内だけが出る
3. B でプランモードに入り、抜ける。期待: B には案内が出ない
4. A で地の文で「次のタスクを始めて」と頼み、Skill ツールで w-active を起動させて計画を承認する。期待: 計画の更新と実装の引き継ぎの案内が出る
5. A で、もう一度プランモードに入って抜ける。期待: `once: true` で外れたので、案内は出ない

## 4. 作業中の Issue を、手元のファイルなしで確かめる

1. `create_branch` でブランチを作り、checkout する。期待: `.pecot/state/.pecot-active` ができない
2. `session_status` を呼ぶ。期待: 作業中の Issue に、その Issue の番号・題名・状態が出る
3. 次のプロンプトを打つ。期待: セッション名が `#<番号> <題名>` になる
4. 別の場所に clone し直し、同じブランチを checkout する。`.pecot/state/` が無いことを確かめる
5. その clone で `pr_create` の下書きを作る。期待: `Closes #<番号>` が入る
6. `main` に戻して `session_status` を呼ぶ。期待: 作業中の Issue は無いと出る

## 5. w-breakdown を確かめる

1. 検証用の Epic で `/pecot-w:w-breakdown` を起動する。期待: Epic の下にタスクができ、Active に載る
2. ブランチを確かめる。期待: `feat/<日時>/<タスクの番号>` にいる。`NNN-<名前>` のブランチはできていない
3. specify まで進める。期待: `specs/<連番>-<名前>/` に spec ができる

## 6. 実機の記録

`hooks/README.md` の実機の記録の表に、版・日付・結果を足す。

| 確かめる点 | 期待 |
|---|---|
| プラグインのスキルの frontmatter のフックが登録されるか | 登録される |
| `command` の `${CLAUDE_PLUGIN_ROOT}` が展開されるか | 展開される |
| `once: true` で PostToolUse（ExitPlanMode）のフックが外れるか | 1 回で外れる |
| resume の後に登録し直されるか | 結果を記録する |
| SessionStart が compact で起動するか | 起動し、セッション名は返さない |
| Copilot CLI が frontmatter のフックを読むか | 結果を記録し、対応を決める |
| Copilot CLI の `beep: true` がターンの完了で鳴るか | 結果を記録し、README の推奨設定の書き方を決める |
| `speckit.git.feature` が、今のブランチ名を受けて新しいブランチを作らないか | 作らない |
