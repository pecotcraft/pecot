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
- `token` は、どの action も入力で受ける。処理ごとに要る token は、この表の「token」の列に書く（research の R7。確かめは [verification/github-io.md](../verification/github-io.md)）
- App の token は `actions/create-github-app-token` で作る。列の「App」は、括弧の中の権限を持つ GitHub App のこと
- このリポの `.github/workflows/` は、`uses: ./actions/<処理>` で同じ action を呼ぶ

## 1. Actions だけで動く処理（pecot-workflow の MCP から外す。表の `session-finish` を除く）

| action | 移す元のコマンド | 呼ぶ雛形 | token |
|---|---|---|---|
| `board-sync` | `board sync` | `pecot-board-sync.yml` | App か PAT（ボードに書く） |
| `session-finish` | `session finish --skip-local-cleanup`（マージの後の片付け。スキルが使う `session_finish` は pecot-workflow に残す） | `pecot-board-sync.yml` | App か PAT。`--delete-branch` は外す（FR-018） |
| `tracker-sync` | `tracker sync security`・`tracker sync dependabot` | 雛形は無い。このリポの `security-alerts.yml`・`dependabot-prs.yml` が呼ぶ | App（Issues: write・Organization projects: write・Security events: read・Secret scanning alerts: read・Vulnerability alerts: read。今の `security-alerts.yml` と同じ） |
| `review-finish` | `review finish --ensure` | `pecot-review.yml` | App |
| `auto-gate`・`auto-start`・`auto-finish` | `auto gate`・`auto start`・`auto finish` | 今は雛形が無い。自動処理の雛形を足すときは `actions/templates/` に置く | App |
| `release-check` | `release check`（このリポの `release.yml` の preflight。スキルが使う `release_check` は pecot-workflow に残す） | 雛形は無い。このリポの `release.yml` が呼ぶ | App（今の `release.yml` と同じ） |

`pecot-review.yml` と `pecot-handoff.yml` は、claude-code-action で pecot-workflow の w-review・w-handoff のスキルを動かす。雛形は `actions/templates/` に移す。スキルは pecot-workflow に残す。

## 2. 公式の MCP に手の無い操作（スキルが `actions_run_trigger` で起動する）

1 つのワークフロー `pecot-github-ops.yml`（`workflow_dispatch`）と、1 つの action `github-ops` にまとめる。`operation` の入力で操作を選ぶ。

| `operation` | 中身 | 入力 | 呼ぶスキル | token |
|---|---|---|---|---|
| `link-branch` | ブランチと Issue をつなぐ（`createLinkedBranch`） | `issue`・`branch` | w-active・w-quick・w-breakdown | `GITHUB_TOKEN`（contents・issues の write） |
| `stack-register` | スタック PR を登録する（Stacks API） | `pr`・`parent_pr` | w-pr | `GITHUB_TOKEN`（contents・pull-requests の write） |
| `project-fields` | ボードのフィールドを作る・名前を変える・消す・選択肢を直す | `project`・設定のファイルの場所 | w-onboarding | App（Organization projects: write） |
| `project-view` | ビューの列と行の分け方を決める（REST の views） | `project`・ビューの名前・列と行の欄 | w-onboarding | App（Organization projects: write） |
| `project-link` | リポをボードにつなぐ | `project`・`repo` | w-onboarding・w-repo-add | App（Organization projects: write に加え、Contents・Issues・Pull requests の write） |
| `repo-settings` | リポの `delete_branch_on_merge` を返す | なし | w-onboarding・w-repo-add | `GITHUB_TOKEN`（contents の read） |
| `workflow-doctor` | Actions の secret と variable の名前を読み、足りないものを返す | なし | w-onboarding | App（Secrets: read・Variables: read） |
| `release-create` | リリースを作る | `tag`・`sha`・本文のファイル | w-release | `GITHUB_TOKEN`（contents の write） |

- `GITHUB_TOKEN` からは組織のボードが見えない（`projectV2` が null、ビューの作成は 403）。ボードを触る operation は App で動かす
- `project-link` は、Organization projects: write だけの App では FORBIDDEN だった。リポの書き込みも持つ App では通った
- `workflow-doctor` は、`GITHUB_TOKEN` に Secrets・Variables の権限が無い。試した 2 つの App にも付いていなかったので、通るところは確かめていない
- 持ち主の種類は、公式の MCP の `get_me` で決める（[contracts/github-io.md](github-io.md) の 1 節）。operation は置かない
- 画面のマージを再現する `merge-async` は置かない。merge queue のあるリポでは、`GITHUB_TOKEN` と App の token のどちらも「Enqueuer is not authorized to merge」で入れられなかった
- スキルは `actions_run_trigger` で起動する。起動は run の ID を返さないので、ワークフローの `run-name` に `operation` とスキルが作った `request_id` を入れ、`actions_list` の `list_workflow_runs` の `display_title` で run を探す
- 結果は、job のログに `PECOT_RESULT` で始まる 1 行の JSON で出す。
  スキルは `actions_list` の `list_workflow_jobs` で job を引き、`get_job_logs` で読む。
  公式の MCP に job summary を読むツールは無い。
  `continue-on-error` の step は失敗しても `conclusion` が `success` になるので、成否も JSON に入れる
- スキルは、利用者にワークフローの起動を頼まない（FR-016）

## 3. 古い雛形の書き換え（FR-029・FR-030）

- `workflow doctor` と w-onboarding は、利用者のリポの `.github/workflows/` に `@pecot/workflow-mcp` を `npx` で呼ぶ雛形を見つけたら、古い雛形として返す
- エージェントは、`actions/templates/` の雛形で置き換える PR を出す。利用者が手で書き換えない
