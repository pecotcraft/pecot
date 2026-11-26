# Data Model: pecot のフィールドを pecot-status・pecot-lane に整理し、Issue に付くすべての機能を MCP から使える

## A. pecot のフィールド

### ProjectConfig（設定ファイル。`.pecot/config/projects/<host>_<owner>_<number>.json`）

| 項目 | 変更 | 内容 |
|---|---|---|
| ファイル名 | 変更 | `<host>_<owner>_<slug>_<suffix>.json` から `<host>_<owner>_<number>.json` にする。ボードの名前を変えても対応が外れない（R2） |
| `workflow_suffix` | 削除 | 読み込みでは捨てる。`project_init` が旧いファイルを移すときに消す |
| `fields.workflow` | 変更なし | `pecot-status` の選択肢の名前と ID |
| `fields.priority`・`fields.size` | 削除 | 読み込みでは捨てる |
| `board_url` | 変更 | フィルタの欄の名前を `pecot-status` にする |

検証の決まり:

- `pecot-lane` の選択肢は設定に写さない。使うたびにボードから読む（R4）
- 旧い形の設定（`workflow_suffix` あり・旧いファイル名）は、`project_init` の後に新しい形になる。それまでの各操作は旧い形を読んで動き、移行の手順を示す

### pecot のフィールド（ボード）

| 名前 | 種類 | 選択肢 | 作るとき |
|---|---|---|---|
| `pecot-status` | single select | Backlog・Pending・Blocked・Ready・Active・In Review・Archived（今の `pecot-workflow-<suffix>` と同じ） | 準備のとき必ず |
| `pecot-lane` | single select | 利用者が `lanes` で決める。値の名前は大文字と小文字を区別する | `lanes` を受けたとき |

### 移行の状態（ボードを整える操作が見る）

```text
旧い形 ──project_init──▶ 改名済み ──project_init(confirm_delete)──▶ 移行済み
  │                        │
  │ pecot-workflow-<s>     │ pecot-status あり
  │ pecot-priority/size    │ pecot-priority/size が残る
```

- 改名と設定の移行は、`project_init` の 1 回で済む
- `pecot-priority`・`pecot-size` の削除は、`confirm_delete: true` を受けた `project_init` だけが行う
- `pecot-status` と `pecot-workflow-<suffix>` が両方あるボードは、`pecot-status` を使い、旧いほうを消す予定として示す

### LaneSummary（`board_show` の結果の `lanes`）

| 項目 | 内容 |
|---|---|
| `name` | `pecot-lane` の値。値の無い組は null |
| `count` | 開いた Item の数 |
| `startable` | 着手できる（Ready で readiness が startable）Item の数 |

ボードの選択肢のうち、Item が 0 件の値も 0 件として並べる（空の領域が分かる）。

## B. Issue の機能

### AttributeDefinition（`issue_attributes` の結果の 1 つ）

| 項目 | 内容 |
|---|---|
| `name` | 機能の名前。ボードのフィールド名・Issue field 名・組み込みの名前（`assignees`・`milestone`・`type`・`labels`・`parent`・`blocked_by`） |
| `source` | `project`・`issue_field`・`issue` |
| `kind` | `single_select`・`multi_select`・`text`・`number`・`date`・`iteration`・`users`・`milestone`・`issue_type`・`labels`・`issue_ref`・`issue_refs`・`unsupported` |
| `options` | 選べる値（選択肢・Iteration・マイルストーン・Issue type・ラベル）。担当者は列挙せず、ログイン名で受ける |
| `writable` | 書けるか。GitHub が計算するもの（Sub-issues progress など）は false。`pecot-status` と組み込みの Status も false（`board_move` で動かす） |
| `unsupported_reason` | `kind` が `unsupported` のときの、扱えない理由（GitHub の種類の名前） |

### AttributeValue（`issue_create`・`issue_edit` の入力の 1 つ）

| 項目 | 内容 |
|---|---|
| `name` | AttributeDefinition の `name` |
| `value` | string・number・string の配列・null（`issue_edit` では外す。`issue_create` では書かずに飛ばす） |
| `source` | 省略できる。同じ名前が複数の `source` にあるときだけ要る |

検証の決まり（すべて、書く前にまとめて確かめる）:

| 確かめ | 合わないとき |
|---|---|
| 名前が定義にある | `unknown_attribute`。似た名前を候補に出す |
| 名前が 1 つの `source` に決まる | `ambiguous_attribute`。候補の `source` を出す |
| `writable` が true | `read_only_attribute` |
| `kind` が `unsupported` でない | `unsupported_attribute`。GitHub の種類の名前を出す |
| 値が `kind` に合う | `invalid_value`。取りうる値を出す。number は数、date は `YYYY-MM-DD`、select は選択肢の名前、iteration は名前か開始日。担当者は担当にできるログイン名 |
| 名前の `source` の定義を読めた | `unreadable_attribute`。読めなかった理由を出す |
| ボードのフィールドなら、Issue がボードに載っている（`issue_edit`） | `not_on_board`。`board_add` を使うよう出す |

### AttributeReading（`issue_show` の結果の `attributes` の 1 つ）

| 項目 | 内容 |
|---|---|
| `name`・`source`・`kind` | 定義と同じ |
| `value` | 入っている値。値の無い機能は出さない |

### 担保の一覧（`plugins/pecot-workflow/interface/issue-coverage.yaml`）

| 項目 | 内容 |
|---|---|
| `id` | 写しの項目の識別子。例: `graphql:CreateIssueInput.milestoneId`、`graphql:UpdateIssueInput.labelIds`、`graphql:ProjectV2FieldValue.iterationId`、`graphql:enum:ProjectV2FieldType.ITERATION`、`graphql:mutation:addBlockedBy`、`rest:POST /repos/{owner}/{repo}/issues#issue_field_values` |
| `status` | `supported`・`excluded` |
| `handler` | `supported` のとき、`ATTRIBUTE_HANDLERS` の鍵。`tool` とどちらか 1 つ |
| `tool` | `supported` のとき、属性でなくツールが書く項目（題・本文・状態・parent・blocked_by など）の MCP のツール名。`handler` とどちらか 1 つ |
| `reason` | `excluded` のとき、外す理由（preview・GitHub が計算する・pecot の流れの外 など） |

`id` の形は次のとおり。

| 項目 | `id` の形 |
|---|---|
| `CreateIssueInput`・`UpdateIssueInput`・`ProjectV2FieldValue` の項目 | `graphql:<型>.<項目>` |
| `ProjectV2FieldType`・`ProjectV2CustomFieldType`・`IssueFieldDataType` の値 | `graphql:enum:<型>.<値>` |
| Issue を対象にする mutation（`input` の項目に、`@possibleTypes` の `concreteTypes` が `["Issue"]` だけのものを持つ） | `graphql:mutation:<名前>` |
| REST の `POST /repos/{owner}/{repo}/issues` の本文の項目。`requestBody` が `$ref` のときは `components` をたどる | `rest:POST /repos/{owner}/{repo}/issues#<項目>` |

### 写し（`plugins/pecot-workflow/interface/github-issue-surface.json`）

| 項目 | 内容 |
|---|---|
| `sources` | 取った URL（`graphql`・`rest`）と日時（`fetched_at`）、REST の API の版（`rest_api_version`） |
| `items` | 項目の `id` の一覧（符号位置の順に並べ替え済み） |

### 差の Issue（定期の確かめが作る）

| 項目 | 内容 |
|---|---|
| 題 | `GitHub の Issue の機能に差がある: <増えた数> 件増・<消えた数> 件減` |
| 本文 | 増えた・消えた項目の `id`、比べたスキーマの出どころと REST の版、写しを作り直す手順 |
| 印 | 本文の末尾の HTML コメント `<!-- pecot-issue-surface: <差の hash> -->`。同じ印の開いた Issue があれば作らない。印が違う開いた差の Issue があれば、その題と本文を書き直す |
