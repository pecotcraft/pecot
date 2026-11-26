# Verification: GitHub 公式の MCP の手と、Actions の token

Phase 2（#789）の確かめの記録。T007〜T018 の操作・結果・読んだ版と日付を書く。結果から決めたことは [contracts/github-io.md](../contracts/github-io.md) と [contracts/actions-interface.md](../contracts/actions-interface.md) に書き戻した。

## 確かめた環境

| 項目 | 値 |
|---|---|
| 日付 | 2026-11-26 |
| クライアント | Claude Code 2.1.332（devcontainer の端末） |
| GitHub MCP Server | リモートのサーバー（`api.githubcopilot.com`）。ツールの入力は github/github-mcp-server の commit `7edc2dd123a8923db389de8772170663cb2d8e17` の `pkg/github/__toolsnaps__/*.snap` で読んだ |
| 検証用のリポとボード | `pecotcraft/pecot-sandbox`、ボード `pecot sandbox`（Projects の 3 番） |
| 試しのワークフロー | `pecot-cuj-789-probe.yml`（末尾に中身を残した）。確かめの間だけ sandbox の `main` に置き、pecotcraft/pecot-sandbox#669 で消した |

claude.ai のコネクタは、toolset ごとに 3 つに分けた。どれも GitHub の OAuth でつなぎ、PAT は使っていない。

| コネクタ | URL | 使ったツール |
|---|---|---|
| `pecot-b` | `https://api.githubcopilot.com/mcp/x/projects` | `projects_write`・`projects_get`・`projects_list` |
| `pecot-c` | `https://api.githubcopilot.com/mcp/insiders` | 既定の toolset（`issue_write`・`create_pull_request` など）と、Insiders の `issue_dependency_write`・`issue_dependency_read` |
| `pecot-a` | `https://api.githubcopilot.com/mcp/x/actions` | `actions_run_trigger`・`actions_list`・`actions_get`・`get_job_logs` |

URL 1 つで指定できる toolset は 1 つだけなので（`docs/remote-server.md` の「URL Path Parameters」）、コネクタを分けた。claude.ai のコネクタはヘッダーを渡せないので、`X-MCP-Toolsets` は使えない。

3 つの URL の resource metadata（`/.well-known/oauth-protected-resource/mcp/<path>`）は、どれも同じ `scopes_supported` を返す。
`repo`・`read:org`・`read:user`・`user:email`・`read:packages`・`write:packages`・`read:project`・`project`・`gist`・`notifications` で、claude.ai のコネクタの承認はこの scope を求める。
GitHub が実際に許した scope は、コネクタのツールからは読めない。下の Issue とボードへの書き込みは通った。

コネクタは claude.ai のサーバーからつなぐ。クラウドのスレッドも同じサーバーからつなぐので、Issue の Tasks の「クラウドのスレッドから」は、この端末の Claude Code から呼んで代えた。セッションを始めた後に付け直したコネクタのツールは、そのセッションに現れない。新しいツールは、子の `claude -p` から呼んだ。

試しのワークフローで比べた token は 3 つ。App の権限は、App の JWT で `GET /app/installations` を呼んで読んだ。

| token | 権限 |
|---|---|
| `GITHUB_TOKEN` | ワークフローの `permissions` で、`contents`・`issues`・`pull-requests` を write、`actions`・`security-events` を read にした。`vulnerability-alerts: read` は、別の 1 本で試した |
| ボードの同期の App（`PECOT_BOARD_SYNC_APP_*`） | Issues: read・Contents: read・Metadata: read・Pull requests: read・Organization projects: write |
| エージェントの App（`PECOT_AGENT_APP_*`） | Issues: write・Actions: read・Contents: write・Metadata: read・Pull requests: write・Organization projects: write |

## 結果の一覧

| タスク | 操作 | 結果 |
|---|---|---|
| T006 | `sandbox-diff.sh` | 着手の前と片付けの後に、ずれが 0 件 |
| T007 | `projects_write` の `add_project_item`・`update_project_item`・`delete_project_item` | 通った。single select は値の名前で書け、`null` で消えた。日付は `2026-12-01` で書け、`null` で消えた |
| T008 | アーカイブした item を外して足し直す | 通った。ただし手順が 3 つ増える（下の T008） |
| T009 | `create_project`・`create_project_view` | 通った。pecot の欄とビューの分け方は作れない（下の T009） |
| T010 | `issue_dependency_write`・`issue_dependency_read` | 通った。付ける・読む・外す・付け直すのどれも |
| T011 | `update_pull_request_branch` | スタック PR では 403 で断られた。親をマージすると、GitHub が子を自分で base に載せ替えた。`pr_restack` を後に流しても変わらなかった（下の T011） |
| T012 | `update_pull_request` の `reviewers` | 通った。App が作った PR に `kouhei0831` を頼めた |
| T013 | `actions_run_trigger`・`actions_list`・`actions_get`・`get_job_logs` | 通った。結果はログから読む（下の T013） |
| T014 | `delete_branch_on_merge` を公式の MCP で読む | 読めなかった。試しのワークフローでは読めた（下の T014） |
| T015 | claude.ai のコネクタと Copilot CLI の GitHub MCP | 手元の Claude Code はコネクタを OAuth で使えた。Copilot CLI は文書で読んだ（下の T015） |
| T016・T017 | token ごとの Actions の処理 | 下の「token ごとの結果」 |
| T018 | 公式の MCP だけで Issue を起票から閉じる | pecot-workflow で同じ操作をした Issue と、ラベル・Issue type・Issue fields・カードの欄がそろった（下の T018） |

## T007: ボードの item を足し、欄を書いて消す

- `add_project_item`（`item_type: issue`・`item_owner`・`item_repo`・`issue_number`）で、pecotcraft/pecot-sandbox#651 をボードに足せた。結果に `item_id` が返る
- `update_project_item` は、`item_id` を渡さずに `issue_number` で item を引けた。`updated_field` は `{"name": "pecot-status", "value": "Blocked"}` の形で、single select は値の名前で書けた
- `{"name": "pecot-lane", "value": null}` で値が消え、GraphQL で読むと `pecot-lane` が無かった
- 日付は、3 番のボードに日付の欄が無いので、T009 で作った使い捨てのボードで試した。`{"name": "cuj-date-agent_app", "value": "2026-12-01"}` で書くと、`get_project_item` が `2026-12-01T00:00:00+00:00` を返した。`null` で消えた
- `delete_project_item` は `item_id` で消せた

## T008: アーカイブした item を戻す

`projects_write` には、item をアーカイブする `method` も、戻す `method` も無い。`gh project item-archive` でアーカイブしてから試した。

- アーカイブ済みの item は、`get_project_item` の `archived_at` に時刻が出た
- アーカイブ済みの item に `update_project_item` を呼ぶと、「This item is archived and cannot be updated」で断られた。書き込んでしまうことは無い
- `delete_project_item` で外し、`add_project_item` で足し直すと、別の `item_id` の item になり、`pecot-lane` が消えていた
- 足し直した item には、ボードの自動化が `Status` に `Done` を入れた。`Status` が `Done` のまま `issue_write` で開き直すと、ボードの自動化が 14 秒後に Issue を閉じ直した
- `Status` を `null` で消してから開き直すと、開いたまま残った。`issue_write` の `state_reason` は `completed`・`not_planned`・`duplicate` だけで、`reopened` は入力の検証で断られた。開き直した Issue の `stateReason` は、GitHub が `REOPENED` にした

pecot-workflow の `issue_reopen` は、アーカイブを解き、`Status` の `Done` を消し、`pecot-status` を `ready` にして、Issue を開き直す（pecotcraft/pecot-sandbox#655）。
公式の MCP では、`delete_project_item` → `add_project_item` → `Status` を `null` → `pecot-status` と `pecot-lane` を書き直す → `issue_write` で開く、の順で同じ状態になった。

| | 公式の MCP（#651） | `issue_reopen`（#655） |
|---|---|---|
| Issue | `OPEN`・`REOPENED` | `OPEN`・`REOPENED` |
| カード | アーカイブ無し、`pecot-status=Ready`・`pecot-lane=repo` | アーカイブ無し、`pecot-status=Ready`・`pecot-lane=repo` |

## T009: ボードとビューを作る

- `create_project`（`owner_type: org`）で、題に `[cuj 789-bjd2]` を入れたボードを作れた。`number`・`url` が返った
- `create_project_view`（`layout: board`）で `Lanes` のビューを作れた。入力に、列と行の分け方（`group_by`・`vertical_group_by`）が無い
- `pecot project create` で作ったボードと比べた

| | 公式の MCP | `project_create` |
|---|---|---|
| `pecot-status`・`pecot-lane` の欄 | 無い | ある |
| `Status` の `Needs Attention` | 無い | ある |
| `Lanes` のビュー | 分け方が `Status`（既定） | 列が `pecot-lane`、行が `pecot-status` |

欄とビューの分け方は、`actions/` の `project-fields` で作る。ビューは REST の `POST /orgs/{org}/projectsV2/{number}/views` で `group_by`・`vertical_group_by` を渡せた（下の「token ごとの結果」）。

使い捨てのボードは、確かめの後に `gh project delete` で消し、`project activate` で 3 番に戻した。

## T010: 前提（blocked-by）

- `issue_dependency_write`（`method: add`・`type: blocked_by`）で、#651 に #652 を前提として付けられた
- `issue_dependency_read`（`get_blocked_by`）が #652 を返し、`remove` の後は空を返した。付け直しも通った
- `issue_block` は、前提を付けたうえで、カードを `Blocked` に動かす。公式の MCP は前提だけを書くので、カードの `pecot-status` は `projects_write` で別に書く。`Waits for merge` の節を Issue の本文に書く `--wait merge` は、`issue_write` の `body` で行う

## T011: スタック PR を追いつかせる

- 公式の MCP で、親 PR（#665、base は `main`）と子 PR（#663、base は親のブランチ）を作り、試しのワークフローの `stack-register` でスタックに登録した
- 親をマージすると、GitHub が子の base を `main` に変えた。子のブランチは `main` から 1 つ進み、遅れは 0 になった。差分は子のファイルだけだった
- その子に `update_pull_request_branch` を呼ぶと、「Updating a stacked PR's branch via this endpoint is not supported」の 403 で断られた

`bin/pecot` でも同じ形のスタックを作って比べた。

- `issue block --wait stack` で子の Issue（#673）を親（#672）に待たせ、`session start` と `pr create` で親 PR（#674）と子 PR（#675）を作った。子の `pr create` が、子をスタックに登録した
- `pr merge 674` で親をマージすると、こちらも GitHub が子の base を `main` に変えて載せ替えた
- その後に子のブランチで `pr restack` を流すと、「synced with origin」と出て、ブランチは変わらなかった

| | 公式の MCP（#663） | `bin/pecot`（#675、`pr restack` の後） |
|---|---|---|
| base | `main` | `main` |
| `main` から進んだ数・遅れた数 | 1・0 | 1・0 |
| PR のファイル | 子のファイル 1 つだけ | 子のファイル 1 つだけ |

スタックに登録した PR は、GitHub が親のマージの後に子を載せ替える。`pr_restack` に当たる手は、公式の MCP にも `actions/` にも要らない。

## T012: レビュアーを頼む

- 試しのワークフローの `create-pr` で、エージェントの App が draft の PR（#666、作った人は `pecot-agent-sandbox[bot]`）を作った
- `update_pull_request` の `reviewers: ["kouhei0831"]` が通り、`pull_request_read`（`get`）の `requested_reviewers` に `kouhei0831` が出た
- 今の `pr_create` はレビュアーを頼まない（`cli/src/commands/pr.ts` に該当の処理が無い）。比べる相手は無い

## T013: Actions を起動して結果を読む

- `actions_run_trigger`（`method: run_workflow`）は、`status_code: 204` と「Workflow run has been queued」を返した。run の ID は返らない
- `actions_list` の `list_workflow_runs`（`workflow_runs_filter.event: workflow_dispatch`）の `display_title` に、`run-name` の `probe <operation> <request_id>` が出た。これで起動した run を見分けられた
- `list_workflow_jobs` で job を引き、`actions_get` の `get_workflow_job` で step を読めた。`continue-on-error: true` の step は、中で失敗しても `conclusion` が `success` になる。step の成否は `conclusion` では読めない
- `get_job_logs`（`job_id`・`return_content: true`）で、ログの本文が返った。`PECOT_RESULT {...}` の行から、operation と token の組ごとの結果の JSON を読めた
- job summary を読むツールは無い。artifact とログの `actions_get` の `method` は、ZIP の URL を返すだけ

## T014: `delete_branch_on_merge` を読む

- `search_repositories`（`minimal_output: false`）の結果に `delete_branch_on_merge` が無かった。持ち主の種類（`owner.type`）も無い
- 公式の MCP のソースでは、`Repositories.Get` を呼ぶのは `CreateBranch` などの内部だけで、リポの設定を返すツールは無い
- 試しのワークフローの `repo-settings`（REST `GET /repos/{owner}/{repo}`）では、`GITHUB_TOKEN` とエージェントの App が `delete_branch_on_merge: true` を読めた。
  ボードの同期の App は、項目そのものが返らなかった。
  GitHub Docs の「Get a repository」は、merge の設定を読むのに `contents:read` と `contents:write` の両方を求める。
  通った `GITHUB_TOKEN` は `contents: write` を持っていた

`github-ops` に `repo-settings` を足す。

## T015: 手元のクライアント

- `claude mcp list` は、`claude.ai pecot-a`・`claude.ai pecot-b`・`claude.ai pecot-c` を、上の URL で「Connected」と出した。手元の Claude Code は、claude.ai のコネクタの GitHub 公式の MCP を、PAT を持たずに使えた
- GitHub Copilot CLI 1.0.114 の `copilot --help` は、組み込みの GitHub MCP の toolset を `--add-github-mcp-toolset <toolset>`（既定の CLI の一部に足す。
  繰り返せる）で足し、`--enable-all-github-mcp-tools` で全部にすると書く。
  `copilot help config` は Insiders を設定の `githubMcpInsiders` で切り替えると書く。
  Copilot CLI では動かしていない
- pecot に要る toolset は、既定の toolset に `projects`・`actions` を足したものと、Insiders（前提の手）

## T016・T017: token ごとの結果

`○` は通った、`×` は断られたことを表す。「エラー」の列は、断られたときの GitHub の文。

| operation | 呼んだ API | `GITHUB_TOKEN` | ボードの同期の App | エージェントの App | エラー |
|---|---|---|---|---|---|
| `link-branch` | GraphQL `createLinkedBranch` | ○ | × | ○ | 「does not have the correct permissions to execute `CreateLinkedBranch`」 |
| `stack-register` | REST `GET`・`POST /stacks` | ○ | × | ○（権限は通り、既に登録済みの 422） | 「Resource not accessible by integration」 |
| `merge-async` | REST `PUT /pulls/{n}/merge-async` | 受け付けたが × | × | 受け付けたが × | 受け付けた 2 つは、結果が「Enqueuer is not authorized to merge」。ボードの同期の App は 403 |
| `project-fields` | GraphQL `createProjectV2Field`・`updateProjectV2Field`・`deleteProjectV2Field` | × | ○ | ○ | `GITHUB_TOKEN` からはボードが見えない（`projectV2` が null） |
| `project-view` | REST `POST /orgs/{org}/projectsV2/{n}/views` | × | ○ | ○ | 403 |
| `project-link` | GraphQL `linkProjectV2ToRepository`・`unlinkProjectV2FromRepository` | × | × | ○ | `GITHUB_TOKEN` は NOT_FOUND。ボードの同期の App は FORBIDDEN |
| `secrets-variables` | REST `GET /actions/secrets`・`/actions/variables` | × | × | × | 3 つとも 403。`GITHUB_TOKEN` にこの権限は無く、2 つの App にも付いていない |
| Dependabot alert | REST `GET /dependabot/alerts` | ○（`vulnerability-alerts: read` を渡したとき） | × | × | 2 つの App にこの権限は付いていない |
| code scanning alert | REST `GET /code-scanning/alerts` | ○ | × | × | 同上 |
| `release-create` | REST `POST /releases` | ○ | × | ○ | 403 |
| `repo-settings` | REST `GET /repos/{owner}/{repo}` | ○ | 項目が無い | ○ | — |
| `create-pr` | REST `POST /pulls` | 試していない | 試していない | ○ | — |

run は次のとおり。どれも sandbox の Actions に残っている（試しのワークフローの中身は末尾）。

| operation | request_id | run |
|---|---|---|
| `repo-settings` | `r-repo-settings` | [45781298643](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45781298643) |
| `app-info` | `r-app-info` | [45781299200](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45781299200) |
| `secrets-variables` | `r-secrets-variables` | [45781299507](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45781299507) |
| `app-info` | `r-app-info2` | [45782039489](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45782039489) |
| `link-branch` | `r-link` | [45782041117](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45782041117) |
| `link-branch` | `r-link2` | [45782144931](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45782144931) |
| `merge-async` | `r-merge-659` | [45782495965](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45782495965) |
| `project-fields` | `r-project-fields` | [45784142329](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45784142329) |
| `project-link` | `r-project-link` | [45784173329](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45784173329) |
| `create-pr` | `r-create-pr` | [45785483395](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45785483395) |
| `stack-register` | `r-stack` | [45785538523](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45785538523) |
| `release-create` | `r-release` | [45785570927](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45785570927) |
| `tracker-sync` | `r-tracker` | [45785600759](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45785600759) |
| `merge-async` | `r-merge-tokens` | [45785868581](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45785868581) |
| `project-view` | `r-view` | [45786351698](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45786351698) |
| `tracker-sync` | `r-tracker2` | [45786351714](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45786351714) |
| `vulnerability-alerts`（別の 1 本、`pecot-cuj-789-perm.yml`） | — | [45782038985](https://github.com/pecotcraft/pecot-sandbox/actions/runs/45782038985) |

- `merge-async` は、`GITHUB_TOKEN` とエージェントの App で「Merge request enqueued.」の 202 が返った。
  `GET /pulls/{n}/merge-async/{uuid}` で読むと、どちらも「Pull request could not be added to the merge queue: Enqueuer is not authorized to merge」で失敗していた。
  sandbox の `main` は merge queue を要する。
  公式の MCP の `merge_pull_request` も、「Changes must be made through the merge queue」の 405 で断られた。
  merge queue のあるリポでは、Actions の token と公式の MCP のどちらからもマージできない。
  利用者の token（`pecot pr merge`）では入った
- `GITHUB_TOKEN` が起こすイベントは、新しい run を作らない（GitHub Docs の「GITHUB_TOKEN」）。`release-create` を `GITHUB_TOKEN` で動かすと、利用者のリポの `on: release` のワークフローが動かないので、App の token にした。
  マージは上のとおり `GITHUB_TOKEN` ではできなかったので、マージの後の board-sync・handoff が動くかは見ていない
- `tracker-sync` は、npm の `@pecot/workflow-mcp@9.0.0` の CLI が今の設定ファイル（`workflow_suffix` を持たない）を読めず、3 つとも同じエラーで止まった。
  sandbox には Dependabot alert も Dependabot の PR も無く、書き込みは起きない。
  tracker-sync の token は、要る読み書き（alert を読む・Issue を作る・ボードに足す）が上の表でそろう App とした。
  このリポの `security-alerts.yml` の App（`SECURITY_APP_*`）は、Issues: write・Organization projects: write・Security events: read・Secret scanning alerts: read・Vulnerability alerts: read を求める。
  sandbox の 2 つの App とは別の App

## T018: 公式の MCP だけで Issue を起票から閉じる

公式の MCP だけで動かした Issue（#650〜#652）と、作業ツリーの `bin/pecot` で同じ操作をした Issue（#653〜#655）を比べた。

| 手順 | 公式の MCP | pecot-workflow |
|---|---|---|
| Epic・Task・前提の Issue を作る | `issue_write`（create）。題の `[Task]`・`[Epic]` は自分で付ける | `issue create`（`--type epic`・`--parent-epic`・`--attribute`） |
| 親を付ける | `sub_issue_write`（add） | `issue create` の `--parent-epic` |
| 前提を付けて外す | `issue_dependency_write` | `issue block`・`issue unblock` |
| ボードに足し、欄を書く | `projects_write`（`add_project_item`・`update_project_item`） | `issue create`・`issue block` が書く |
| ブランチを作って Issue につなぐ | 試しのワークフローの `link-branch`（エージェントの App） | `session start` |
| commit と PR | `push_files`・`create_pull_request` | git の push と `pr create` |
| `In Review` にする | `projects_write` | `pr create` が書く |
| マージ | `pecot pr merge`（利用者の token。上の `merge-async` のとおり、公式の MCP と Actions の token ではできない） | `pr merge` |
| Issue を閉じる | sandbox の `pecot-board-sync.yml` | 同じ |

マージの後に読んだ値は次のとおり。

| | 公式の MCP（#651） | pecot-workflow（#655） |
|---|---|---|
| 状態 | `CLOSED`・`COMPLETED` | `CLOSED`・`COMPLETED` |
| 親 | #650 | #653 |
| 前提 | 無し（外した） | 無し（外した） |
| ラベル・Issue type | 無し | 無し |
| カード | `pecot-status=In Review`・`pecot-lane=repo`・`Status=Done` | `pecot-status=In Review`・`pecot-lane=repo`・`Status=Done` |
| つながったブランチ | `cuj/789-8h2g/gt`・`cuj/789-8h2g/ag`（token の試しで作ったもの。作業のブランチはマージで消えた） | 無し（マージで消えた） |

違ったのは、つながったブランチだけで、token を比べるために余分に作ったブランチが残ったことによる。Epic と前提の Issue のカードも、公式の MCP で `Backlog`・`Ready` を書くと、pecot-workflow のものとそろった。

上の 6 件は、ラベル・Issue type・Issue fields を付けずに作った。そこで、同じ値を付けた Issue を 1 件ずつ作り直して比べた。

- pecot-workflow（#670）: `issue create` の `--attribute` で、`Priority=High`・`Target date=2026-12-01`・`type=Task`・`labels=["documentation"]` を渡し、`--lane repo` を付けた
- 公式の MCP（#671）: `issue_write`（create）の `type: "Task"`・`labels: ["documentation"]`・`issue_fields`（`Priority` は `field_option_name: "High"`、`Target date` は `value: "2026-12-01"`）で作った。
  `projects_write` で `pecot-status=Ready`・`pecot-lane=repo` を書いた

| | 公式の MCP（#671） | pecot-workflow（#670） |
|---|---|---|
| Issue type | `Task` | `Task` |
| ラベル | `documentation` | `documentation` |
| Issue fields | `Priority=High`・`Target date=2026-12-01` | `Priority=High`・`Target date=2026-12-01` |
| カード | `pecot-status=Ready`・`pecot-lane=repo`・`Status=Todo` | `pecot-status=Ready`・`pecot-lane=repo`・`Status=Todo` |

## 片付け

- 試しのワークフローは pecotcraft/pecot-sandbox#669 で消した
- 使い捨てのボード 2 つは `gh project delete` で消した
- Issue・PR・ブランチ・リリースは `sandbox-sweep.sh --issue 789` で片付けた
- `cuj/789-*.md` の確かめのファイルは、sandbox の `main` に残る（ほかの CUJ の `cuj/` と同じ扱い）

## 試しのワークフロー

```yaml
# pecotcraft/pecot#789 の確かめで一時的に置く。確かめが済んだら消す。
name: pecot cuj 789 probe
run-name: probe ${{ inputs.operation }} ${{ inputs.request_id }}

on:
  workflow_dispatch:
    inputs:
      operation:
        description: "app-info / project-view / repo-settings / secrets-variables / stack-register / merge-async / project-fields / project-link / release-create / link-branch / create-pr / tracker-sync"
        required: true
        type: string
      request_id:
        required: true
        type: string
      targets:
        description: 'JSON keyed by token name (github_token / board_app / agent_app), e.g. {"board_app":{"pr":12}}'
        required: false
        default: "{}"
        type: string
      tokens:
        description: "Comma-separated token names to try"
        required: false
        default: "github_token,board_app,agent_app"
        type: string

permissions:
  contents: write
  issues: write
  pull-requests: write
  actions: read
  security-events: read

jobs:
  probe:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    env:
      OPERATION: ${{ inputs.operation }}
      TARGETS: ${{ inputs.targets }}
      TOKENS: ${{ inputs.tokens }}
      REPO: ${{ github.repository }}
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Board sync app token
        id: board-app
        uses: actions/create-github-app-token@f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc # v3.4.0
        with:
          client-id: ${{ vars.PECOT_BOARD_SYNC_APP_CLIENT_ID }}
          private-key: ${{ secrets.PECOT_BOARD_SYNC_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}

      - name: Agent app token
        id: agent-app
        uses: actions/create-github-app-token@f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc # v3.4.0
        with:
          client-id: ${{ vars.PECOT_AGENT_APP_CLIENT_ID }}
          private-key: ${{ secrets.PECOT_AGENT_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}

      - name: Write the probe script
        run: |
          cat > "$RUNNER_TEMP/probe.sh" <<'EOF'
          #!/usr/bin/env bash
          # usage: probe.sh <token name>. GH_TOKEN holds the token.
          set -uo pipefail
          name=$1
          case ",$TOKENS," in *",$name,"*) ;; *) echo "skip $name"; exit 0 ;; esac
          t=$(jq -c --arg n "$name" '.[$n] // {}' <<<"$TARGETS")
          owner=${REPO%%/*}
          v() { jq -r --arg k "$1" '.[$k] // empty' <<<"$t"; }
          results='[]'
          # call <label> <gh api args...>: records HTTP status and the body (or its message)
          call() {
            local label=$1; shift
            local out status body
            out=$(gh api -i "$@" 2>/dev/null); status=$(head -1 <<<"$out" | awk '{print $2}')
            body=$(sed '1,/^\r\{0,1\}$/d' <<<"$out")
            jq -e . >/dev/null 2>&1 <<<"$body" || body=$(jq -Rs . <<<"$body")
            results=$(jq -c --arg l "$label" --arg s "${status:-0}" --argjson b "$body" '. + [{label: $l, status: ($s|tonumber), body: $b}]' <<<"$results")
            LAST=$body
          }
          # GraphQL returns 200 with errors; record those as status 0
          gql() {
            local label=$1; shift; call "$label" graphql "$@"
            if jq -e 'type=="object" and has("errors")' >/dev/null 2>&1 <<<"$LAST"; then results=$(jq -c '.[-1].status = 0' <<<"$results"); fi
          }
          b64() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
          project_id() { gh api graphql -f query='query($o:String!,$n:Int!){organization(login:$o){projectV2(number:$n){id}}}' -f o="$owner" -F n="$(v project_number)" --jq '.data.organization.projectV2.id' 2>/dev/null; }
          case "$OPERATION" in
            app-info)
              if [ -z "${APP_CLIENT_ID:-}" ]; then results='[{"label":"not an app","status":200}]'; else
                now=$(date +%s); key=$(mktemp); printf '%s' "$APP_KEY" > "$key"
                head=$(printf '{"alg":"RS256","typ":"JWT"}' | b64)
                payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now-60)) $((now+300)) "$APP_CLIENT_ID" | b64)
                sig=$(printf '%s.%s' "$head" "$payload" | openssl dgst -sha256 -sign "$key" | b64); rm -f "$key"
                body=$(curl -sS -H "Authorization: Bearer $head.$payload.$sig" -H "Accept: application/vnd.github+json" https://api.github.com/app/installations | jq -c --arg o "$owner" '[.[]? | select(.account.login==$o) | {id, permissions, repository_selection}]' 2>&1)
                jq -e . >/dev/null 2>&1 <<<"$body" || body=$(jq -Rs . <<<"$body")
                results=$(jq -c --argjson b "$body" '[{label: "installations", status: 200, body: $b}]' <<<'[]')
              fi ;;
            repo-settings)
              call repo "repos/$REPO"
              LAST=$(jq -c '{has_delete_branch_on_merge: has("delete_branch_on_merge"), delete_branch_on_merge, owner_type: .owner.type}' <<<"$LAST")
              results=$(jq -c --argjson x "$LAST" '.[-1].body = $x' <<<"$results") ;;
            secrets-variables)
              call secrets "repos/$REPO/actions/secrets" --jq '{names: [.secrets[].name]}'
              call variables "repos/$REPO/actions/variables" --jq '{names: [.variables[].name]}'
              call dependabot-alerts "repos/$REPO/dependabot/alerts?per_page=1" --jq 'length'
              call code-scanning-alerts "repos/$REPO/code-scanning/alerts?per_page=1" --jq 'length' ;;
            stack-register)
              call stacks-list "repos/$REPO/stacks?pull_request=$(v parent_pr)" -H 'X-GitHub-Api-Version: 2026-03-10'
              call stacks-create "repos/$REPO/stacks" -X POST -H 'X-GitHub-Api-Version: 2026-03-10' --input <(jq -c '{pull_requests: [.parent_pr, .child_pr]}' <<<"$t") ;;
            merge-async)
              sha=$(gh api "repos/$REPO/pulls/$(v pr)" --jq .head.sha 2>/dev/null)
              call merge-async "repos/$REPO/pulls/$(v pr)/merge-async" -X PUT -H 'X-GitHub-Api-Version: 2026-03-10' -f sha="$sha" ;;
            project-fields)
              pid=$(project_id)
              gql create-single-select -f query='mutation($p:ID!,$n:String!){createProjectV2Field(input:{projectId:$p,dataType:SINGLE_SELECT,name:$n,singleSelectOptions:[{name:"A",color:GRAY,description:""}]}){projectV2Field{... on ProjectV2SingleSelectField{id name}}}}' -f p="$pid" -f n="cuj-sel-$name"
              fid=$(jq -r '.data.createProjectV2Field.projectV2Field.id // empty' <<<"$LAST")
              gql rename -f query='mutation($f:ID!,$n:String!){updateProjectV2Field(input:{fieldId:$f,name:$n}){projectV2Field{... on ProjectV2SingleSelectField{id name}}}}' -f f="$fid" -f n="cuj-sel2-$name"
              gql options -f query='mutation($f:ID!){updateProjectV2Field(input:{fieldId:$f,singleSelectOptions:[{name:"A",color:GRAY,description:""},{name:"B",color:BLUE,description:""}]}){projectV2Field{... on ProjectV2SingleSelectField{id options{name}}}}}' -f f="$fid"
              gql delete -f query='mutation($f:ID!){deleteProjectV2Field(input:{fieldId:$f}){projectV2Field{... on ProjectV2FieldCommon{id name}}}}' -f f="$fid"
              gql create-date -f query='mutation($p:ID!,$n:String!){createProjectV2Field(input:{projectId:$p,dataType:DATE,name:$n}){projectV2Field{... on ProjectV2Field{id name dataType}}}}' -f p="$pid" -f n="cuj-date-$name" ;;
            project-view)
              fid=$(gh api graphql -f query='query($o:String!,$n:Int!){organization(login:$o){projectV2(number:$n){field(name:"Status"){... on ProjectV2SingleSelectField{databaseId}}}}}' -f o="$owner" -F n="$(v project_number)" --jq '.data.organization.projectV2.field.databaseId' 2>/dev/null)
              call view "orgs/$owner/projectsV2/$(v project_number)/views" -X POST --input <(jq -nc --arg n "Lanes-$name" --argjson f "${fid:-0}" '{name: $n, layout: "board", vertical_group_by: [$f], group_by: [$f]}') --jq '{id, number, name}' ;;
            project-link)
              pid=$(project_id)
              rid=$(gh api "repos/$REPO" --jq .node_id 2>/dev/null)
              gql link -f query='mutation($p:ID!,$r:ID!){linkProjectV2ToRepository(input:{projectId:$p,repositoryId:$r}){repository{nameWithOwner}}}' -f p="$pid" -f r="$rid"
              gql unlink -f query='mutation($p:ID!,$r:ID!){unlinkProjectV2FromRepository(input:{projectId:$p,repositoryId:$r}){repository{nameWithOwner}}}' -f p="$pid" -f r="$rid" ;;
            release-create)
              call release "repos/$REPO/releases" -X POST -f tag_name="$(v tag)" -f target_commitish=main -f name="$(v tag)" -f make_latest=false --jq '{id, tag_name, html_url}' ;;
            link-branch)
              iid=$(gh api "repos/$REPO/issues/$(v issue)" --jq .node_id 2>/dev/null)
              oid=$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha 2>/dev/null)
              rid=$(gh api "repos/$REPO" --jq .node_id 2>/dev/null)
              gql link-branch -f query='mutation($i:ID!,$o:GitObjectID!,$n:String!,$r:ID!){createLinkedBranch(input:{issueId:$i,oid:$o,name:$n,repositoryId:$r}){linkedBranch{ref{name}}}}' -f i="$iid" -f o="$oid" -f n="$(v branch)" -f r="$rid" ;;
            create-pr)
              call create-pr "repos/$REPO/pulls" -X POST -f head="$(v head)" -f base=main -f title="$(v title)" -f body="$(v body)" -F draft=true --jq '{number, html_url, user: .user.login}' ;;
            tracker-sync)
              export PECOT_GITHUB_COM_TOKEN=$GH_TOKEN
              for k in security dependabot; do
                out=$(npx -y @pecot/workflow-mcp@9.0.0 tracker sync "$k" 2>&1); code=$?
                results=$(jq -c --arg l "tracker-$k" --argjson c "$code" --arg o "$(tail -c 3000 <<<"$out")" '. + [{label: $l, status: $c, body: $o}]' <<<"$results")
              done ;;
            *) results='[{"label":"unknown operation","status":0}]' ;;
          esac
          line=$(jq -c --arg op "$OPERATION" --arg n "$name" '{operation: $op, token: $n, calls: .}' <<<"$results")
          echo "PECOT_RESULT $line"
          { echo "### $OPERATION / $name"; echo '```json'; jq . <<<"$line"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
          jq -e 'all(.[]; .status >= 200 and .status < 300)' >/dev/null <<<"$results"
          EOF
          chmod +x "$RUNNER_TEMP/probe.sh"

      - name: ${{ inputs.operation }} / github_token
        continue-on-error: true
        env:
          GH_TOKEN: ${{ github.token }}
        run: '"$RUNNER_TEMP/probe.sh" github_token'

      - name: ${{ inputs.operation }} / board_app
        continue-on-error: true
        env:
          GH_TOKEN: ${{ steps.board-app.outputs.token }}
          APP_CLIENT_ID: ${{ vars.PECOT_BOARD_SYNC_APP_CLIENT_ID }}
          APP_KEY: ${{ secrets.PECOT_BOARD_SYNC_APP_PRIVATE_KEY }}
        run: '"$RUNNER_TEMP/probe.sh" board_app'

      - name: ${{ inputs.operation }} / agent_app
        continue-on-error: true
        env:
          GH_TOKEN: ${{ steps.agent-app.outputs.token }}
          APP_CLIENT_ID: ${{ vars.PECOT_AGENT_APP_CLIENT_ID }}
          APP_KEY: ${{ secrets.PECOT_AGENT_APP_PRIVATE_KEY }}
        run: '"$RUNNER_TEMP/probe.sh" agent_app'
```
