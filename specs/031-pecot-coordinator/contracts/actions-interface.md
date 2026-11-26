# Contract: `actions/` の action と雛形

`actions/` は、利用者のリポのワークフローが `uses:` で呼ぶ action と、そのワークフローの雛形を持つ（FR-010〜FR-012・FR-016・FR-017）。
スキル・MCP のサーバ・エージェントに向けたものは持たない。

## 呼び方

```yaml
- uses: pecotcraft/pecot/actions/<処理>@pecot-actions/v<版>
  with:
    token: ${{ steps.app-token.outputs.token }}
```

- 版のタグは `pecot-actions/v<版>`（research の R6）。`actions/` の全部の action が、同じタグで出る
- `token` は、どの action も入力で受ける。どの処理に App の token が要るかは Phase 2 で決め、この表の「token」の列に書く（research の R7）
- このリポの `.github/workflows/` は、`uses: ./actions/<処理>` で同じ action を呼ぶ

## 1. Actions だけで動く処理（pecot-workflow の MCP から外す。表の `session-finish` を除く）

| action | 移す元のコマンド | 呼ぶ雛形 | token |
|---|---|---|---|
| `board-sync` | `board sync` | `pecot-board-sync.yml` | App か PAT（ボードに書く） |
| `session-finish` | `session finish --skip-local-cleanup`（マージの後の片付け。スキルが使う `session_finish` は pecot-workflow に残す） | `pecot-board-sync.yml` | App か PAT。`--delete-branch` は外す（FR-018） |
| `tracker-sync` | `tracker sync security`・`tracker sync dependabot` | 雛形は無い。このリポの `security-alerts.yml`・`dependabot-prs.yml` が呼ぶ | Phase 2 |
| `review-finish` | `review finish --ensure` | `pecot-review.yml` | App |
| `auto-gate`・`auto-start`・`auto-finish` | `auto gate`・`auto start`・`auto finish` | 今は雛形が無い。自動処理の雛形を足すときは `actions/templates/` に置く | App |

`pecot-review.yml` と `pecot-handoff.yml` は、claude-code-action で pecot-workflow の w-review・w-handoff のスキルを動かす。雛形は `actions/templates/` に移す。スキルは pecot-workflow に残す。

## 2. 公式の MCP に手の無い操作（スキルが `actions_run_trigger` で起動する）

1 つのワークフロー `pecot-github-ops.yml`（`workflow_dispatch`）と、1 つの action `github-ops` にまとめる。`operation` の入力で操作を選ぶ。

| `operation` | 中身 | 入力 | 呼ぶスキル | token |
|---|---|---|---|---|
| `owner-type` | リポの持ち主が組織か人かを返す | `owner` | w-onboarding（`create_project` の前） | `GITHUB_TOKEN` |
| `link-branch` | ブランチと Issue をつなぐ（`createLinkedBranch`） | `issue`・`branch` | w-active・w-quick・w-breakdown | `GITHUB_TOKEN`（2026-11-26 に通った） |
| `stack-register` | スタック PR を登録する（Stacks API） | `pr`・`parent_pr` | w-pr | Phase 2 |
| `merge-async` | sandbox で画面のマージを再現する | `pr` | 試験環境の CUJ | Phase 2 |
| `project-fields` | ボードのフィールドを作る・名前を変える・消す・選択肢を直す | `project`・設定のファイルの場所 | w-onboarding | App か PAT |
| `project-link` | リポをボードにつなぐ | `project`・`repo` | w-onboarding・w-repo-add | App か PAT |
| `workflow-doctor` | Actions の secret と variable の名前を読み、足りないものを返す | なし | w-onboarding | Phase 2 |
| `release-create` | リリースを作る | `tag`・`sha`・本文のファイル | w-release | `GITHUB_TOKEN`（contents の write） |

- スキルは `actions_run_trigger` で起動し、`actions_list`・`actions_get` で結果を読む。結果は run の job の summary に JSON で出す
- スキルは、利用者にワークフローの起動を頼まない（FR-016）

## 3. 古い雛形の書き換え（FR-029・FR-030）

- `workflow doctor` と w-onboarding は、利用者のリポの `.github/workflows/` に `@pecot/workflow-mcp` を `npx` で呼ぶ雛形を見つけたら、古い雛形として返す
- エージェントは、`actions/templates/` の雛形で置き換える PR を出す。利用者が手で書き換えない
