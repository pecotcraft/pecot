# Data Model: pecot-workflow のフックの棚卸しと状態の持ち方

**Feature**: [spec.md](spec.md) | **Research**: [research.md](research.md)

## 作業中の Issue

ファイルに持たず、求めるたびに git から読む。

| 項目 | 求め方 |
|---|---|
| owner/repo | 主の remote の URL |
| 番号 | チェックアウト中のブランチ名の、最後の `/` より後ろ。数字だけのときに限る |

| 状態 | 条件 |
|---|---|
| ある | remote を読め、ブランチ名の末尾が番号だ |
| 無い | ブランチ名の末尾が番号でない。detached HEAD。remote を読めない。git の外 |

| 遷移 | きっかけ |
|---|---|
| 無い → ある | 紐づいたブランチを checkout した |
| ある → 別の Issue | 別の紐づいたブランチに切り替えた |
| ある → 無い | 待機用のブランチや `main` に戻った |

求める場所は 2 つある。

| 場所 | ディレクトリ | 使う値 |
|---|---|---|
| MCP ツール（`pr_create`・`session_status`） | セッションを始めたリポ。`directory` を受けるツールはその値 | owner/repo と番号 |
| フック（`session-title`・`exit-plan-remind`） | `CLAUDE_PROJECT_DIR` | 番号だけ |

## 状態の置き場（変更の後）

```text
.pecot/state/
├── .pecot-session-title       # 題名のキャッシュ。無ければ `#<番号>` だけを出す
├── session-title-sent         # 送った題名のキャッシュ。消えても、名前をもう一度送るだけ
└── .plugin-sync-version       # .pecot の初期化の印（変えない）
```

3 つとも、消えても動作が変わらない。クラウドのセッションで消えてよい。

| ファイル | 書き手 | 読み手 | 消し手 |
|---|---|---|---|
| `.pecot-session-title` | `create_branch`・`issue_quick`（ブランチを作ったとき） | `session-title` | `pr_cleanup` |
| `session-title-sent` | `session-title` | `session-title` | 上書き |

作らなくなるファイルは次のとおり。古い版のものが残っていても、読む者はいない。

| ファイル | 撤廃の理由 |
|---|---|
| `pr-create-slash-pending`・`issue-create-slash-pending`・`merge-slash-pending` | 承認の撤廃 |
| `issue-pending` | 起票待ちのリマインドの撤廃 |
| `.auto-push-urls`・`.wip-branch-linked` | `auto-push` の撤廃 |
| `.pecot-active` | 作業中の Issue を git から求める |
| `.pecot-quick-mode` | 計画の承認の後の案内を、frontmatter のフックに移す |

## スキルの frontmatter のフック

セッションに結びつく状態は、ファイルではなく、スキルの起動で登録されるフックが持つ。

| スキル | イベント | 引数 | `once` | 出す案内 |
|---|---|---|---|---|
| w-active | PostToolUse（ExitPlanMode） | `--mode=active` | true | 計画の更新、実装の引き継ぎ |
| w-quick | PostToolUse（ExitPlanMode） | `--mode=quick` | true | 計画の更新 |

| 遷移 | きっかけ |
|---|---|
| 未登録 → 登録 | そのセッションでスキルを起動した（スラッシュコマンドか Skill ツール） |
| 登録 → 外れる | 計画を承認した（ExitPlanMode の成功）。またはセッションの終わり |

案内の中身は、今のテンプレートを使う（`hooks/templates/` の `exit-plan-comment-update.md`・`exit-plan-implementer-remind.md`）。
作業中の Issue が無いときは、何も出さない。

## 分解のタスク（w-breakdown）

| 項目 | 値 |
|---|---|
| 作り方 | `issue_quick` を `parent_epic` 付きで呼ぶ |
| 親 | 分解する Epic |
| ボードの列 | Active |
| ブランチ | `feat/<日時>/<タスクの番号>`。タスクに紐づく |
| speckit のディレクトリ | `specs/<連番>-<名前>/`。ブランチ名とは揃えない |

## フックの判定（research の表の 1 行）

| 項目 | 内容 |
|---|---|
| 名前 | スクリプトか設定キー |
| 判定 | 残す・消す・置き換える |
| 理由 | 1 文 |
| 置き換え先 | 置き換えるときだけ |
| クライアント | Claude・Copilot・両方 |
