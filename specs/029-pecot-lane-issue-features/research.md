# Research: pecot のフィールドを pecot-status・pecot-lane に整理し、Issue に付くすべての機能を MCP から使える

調べた日: 2026-11-17。GitHub の GraphQL は、公開スキーマ（<https://docs.github.com/public/fpt/schema.docs.graphql>）をこの日に取って読んだ。REST は docs.github.com の `X-GitHub-Api-Version: 2026-03-10` のページを読んだ。

## R1. `pecot-workflow-<suffix>` を `pecot-status` に改名する

- **Decision**: ボードを整える操作（`project_init`）が、`updateProjectV2Field` に `fieldId` と `name: "pecot-status"` だけを渡して改名する。選択肢（`singleSelectOptions`）は渡さない
- **Rationale**: スキーマの説明は「Empty input is ignored」。選択肢を渡さなければ、選択肢の ID と各 Item の値はそのまま残る（FR-030・SC-005b）。選択肢を渡すと全部の置き換えになり、ID を付け忘れた選択肢の値が消える
- **Alternatives considered**:
  - 新しいフィールドを作って値を写し、古いほうを消す: 値の写しの途中で止まると、値が二重か欠ける。改名の API があるので要らない
  - pecot の各操作が旧い名前を見つけたら改名する: clarify で、ボードを整える操作だけが移行すると決めた

## R2. `suffix` の入力を無くす

- **Decision**:
  - `project_create`・`project_init` の入力から `suffix` を外す。設定の `workflow_suffix` を消す
  - 設定ファイルの名前は `${host}_${owner}_${number}.json` にする。ボードの持ち主と番号で一意に決まる。ボードの名前は画面で変えられるので使わない
  - `project_init` は、旧い名前の設定ファイル（`${host}_${owner}_${slugify(name)}_${suffix}.json`）を見つけたら新しい名前に移し、使用中のプロジェクトの指定（設定ファイルの stem）も書き換える
  - `board_url` のフィルタ（`filterQuery`）の欄の名前も `pecot-status` にする
- **Rationale**: 調べた範囲で `suffix` の用途は、フィールド名・設定ファイル名・`board_url` の 3 つだけだった。w-onboarding の「ラベル識別子に使用」は、コードに当たる箇所が無く、文書の誤り。3 つとも、ボードの持ち主・名前と固定の名前で置き換えられる
- **Alternatives considered**: 設定ファイル名にだけ `suffix` を残す。clarify で、入力ごと無くすと決めた
- **触らないもの**: `issue create --prepare --suffix`（作業のファイル名の接尾辞）と、w-issueize の `suffix` キーは、別の機能なので変えない

## R3. `pecot-priority`・`pecot-size` を廃止する

- **Decision**:
  - 作成（`project.ts` の `initializeFields`）・選択肢の定め（`project-sync.ts`）・設定（`config.ts` の `fields.priority`・`size`）・起票の入力と既定値（`issue-create.ts`・frontmatter・テンプレート 5 本）・トラッカーの `putOnBoard` の priority を消す
  - security tracker の本文の表は、「Priority」の列を「Severity」にし、GitHub の重大度をそのまま出す
  - dependabot tracker の `PRIORITY='medium'` を消す
  - w-quick の「priority=medium, size=s」と、`hooks/lib/core/mcp-guidance.sh` の該当の文を消す
  - 既存の設定ファイルに `fields.priority`・`size` があっても読み捨てる（zod の `strip`）
  - 既存のテンプレートの frontmatter に `priority`・`size` があっても無視する
  - `project_init` は、ボードに 2 つのフィールドがあれば、消すフィールドを示す。`confirm_delete` を受けたときだけ `deleteProjectV2Field` で消す
- **Rationale**: FR-008〜FR-010。消すと値が戻らないので、確認を入力で受ける（clarify の決定）。MCP には対話の確認が無いので、1 回目は消す予定を返し、2 回目に `confirm_delete: true` で消す
- **Alternatives considered**: MCP の elicitation で確認を取る。対応しないクライアントがあり、CLI の利用と形がそろわない

## R4. `pecot-lane` を足す

- **Decision**:
  - `project_create`・`project_init` に入力 `lanes`（文字列の配列）を足す
  - フィールドが無ければ `createProjectV2Field`（`SINGLE_SELECT`）で作る。あれば、既存の選択肢を ID ごと読み、足りない値を足した全体を `updateProjectV2Field` に渡す。選択肢は消さない
  - `lanes` を渡さず、フィールドも無いときは作らず、値を決めるよう案内する（US1 の 4）
  - 設定には `pecot-lane` の選択肢を写さない。起票・同期・一覧は、使うたびにボードの `pecot-lane` の選択肢を読む
- **Rationale**:
  - 選択肢の更新は全部の置き換えなので、既存の ID を必ず付ける（R1 と同じ）
  - B は、`attributes` の値を書くたびにボードから読んだ定義で照らす（R7）。設定にも選択肢を写すと、同じ選択肢を 2 か所で持つ。
    利用者が画面で選択肢を足すと、`project_init` まで 2 つが食い違い、`attributes` では書けるのに `lane` では止まる。
    憲章の VIII（同じものを表すモデルは 1 つ）に合わせ、ボードだけを正にする
- **Alternatives considered**:
  - Issue fields に置く。clarify で、ボードのフィールドに置くと決めた
  - 今の `pecot-status` と同じく、設定に選択肢の ID を写す（`fields.lane`）。起票のたびにボードを読まずに済むが、上の食い違いが起きる

## R5. 領域のレーンのビュー

- **Decision**:
  - ボードを準備する操作が、REST の `POST /orgs/{org}/projectsV2/{number}/views`（個人は `/users/{user_id}/...`）でビューを作る
  - 入力は、`name: "Lanes"`・`layout: "board"`・`vertical_group_by: [pecot-status の ID]`・`group_by: [pecot-lane の ID]`
  - 同じ名前のビューが既にあれば作らない
  - 作れないとき（403・404・API の無い GHES）は、手で作る手順を出して、ほかの準備を続ける
- **Rationale**: Group by を指定できるのは REST の作成だけだった。GraphQL の `createProjectV2View` の構成は `visibleFieldIds` だけで、Group by を持たない。ボードのレイアウトで、列を `pecot-status`、横のレーンを `pecot-lane` にすると、Epic の言う「領域ごとのレーン」になる
- **Alternatives considered**: GraphQL の `createProjectV2View` で作り、Group by は手で設定させる。手順が残り、FR-003 を満たさない

## R6. 起票・同期・一覧での `pecot-lane`

- **Decision**:
  - `issue_create` に入力 `lane` を足す。`attributes` の `pecot-lane` を短く書く入力として扱い、照らし合わせと書き込みは R7 の仕組みに任せる。無い値なら Issue を作る前に止める（US2 の 4）
  - 名前から選択肢を引く関数は 1 つにし、B の single select の照らし合わせ（R7）と共有する
  - `parent_epic` があり `lane` が無ければ、CLI が親の値を読んで同じ値にする（US2 の 2）
  - スキル（w-quick・w-ready・w-issueize・w-backlog）は、利用者が分類を言ったときだけ `lane` を渡す。推し量らず、尋ねない
  - `board_sync` は変えない。値の無い Issue を挙げない
  - `board_show` の各 Item に `lane` を足し、結果に `lanes`（値ごとの件数。着手できる件数を含む）を足す
  - w-active は、`board_show` の `items[].lane` と readiness で、候補を値ごとに出す
  - `pecot-lane` の無いボードでは、`lane` は null、`lanes` は空で、Markdown は今と同じにする。起票で `lane` を渡されたら、書かずに警告を出す
- **Rationale**: `pecot-lane` は、Issue を分類したい人が使う任意の欄にする（2026-11-25 の clarify）。入れることを求めたり、値の無い Issue を警告したりすると、使い道を pecot が決めることになる。親の値の引き継ぎは決まった処理なので、エージェントに任せず CLI でする
- **Alternatives considered（2026-11-25 まで）**: 起票するスキルが内容から値を決め、`board_sync` が値の無い Issue を警告する形。全 Issue に値を入れる運用を前提にするので、採らない
- **Alternatives considered**: `board_show` の結果を領域ごとの入れ子にする。今の `items` の形を変えると、ほかの利用（readiness など）を直す必要がある。集計の `lanes` を足すだけにする

## R7. Issue の機能を名前で扱う（B）

- **Decision**:
  - 新しい MCP ツール `issue_attributes` を足す。そのボードと持ち主で使える機能の定義を返す。返すのは、ボードのフィールド（種類・選択肢・Iteration）、Issue fields、Issue type、ラベル、マイルストーン、担当にできる人の確かめ方
  - `issue_create` に入力 `attributes`（`{name, value, source?}` の配列）を足す。`source` は `project` か `issue_field` で、同じ名前が両方にあるときだけ要る
  - 担当者・マイルストーン・Issue type も、`attributes` の組み込みの名前（`assignees`・`milestone`・`type`）で受ける
  - 新しい MCP ツール `issue_edit` を足す。既存の Issue の機能の値を変える・外す
  - `issue_show` は、値の入っている機能をすべて返す。ボードの `fieldValues` を全部の種類で読み、Issue fields・担当者・マイルストーン・ラベル・Issue type も読む
  - 書く前に、すべての値を、そのときにボードと持ち主から読んだ定義と照らす。1 つでも合わなければ何も書かず、合わない機能・値と取りうる値を返す
  - 照らす中身は、種類の合わない値・無い名前・書き込めない機能・同じ名前の曖昧さ
  - `pecot-status` と組み込みの Status（札）は、書き込めない機能として返す。列の移動は `board_move` が、移動の決まり（Blocked の判定など）と共に行う。
    `attributes` からも書けると、同じことをする道が 2 つになる（憲章の VIII）
- **書き方**:
  - Issue の作成は今の REST `POST /issues` のまま。`type`・`assignees`・`milestone`・`labels` を同じ要求に入れる
  - Issue fields は、作成の後に `POST /issues/{n}/issue-field-values` で書く。外すときは `DELETE /issues/{n}/issue-field-values/{issue_field_id}`
  - ボードのフィールドは `updateProjectV2ItemFieldValue` で書く。種類は text・number・date・single select・multi select・iteration
  - blocked-by は、作成の後に `addBlockedBy`（今の形）
  - 更新は REST の `PATCH /issues/{n}` と `issue-field-values` と、GraphQL の `updateProjectV2ItemFieldValue`・`clearProjectV2ItemFieldValue` を使う
  - 担当者は、書く前に `GET /repos/{owner}/{repo}/assignees/{assignee}` で、担当にできるかを確かめる
  - 組み込みは、権限が無いと GitHub が捨てる。応答の値と頼んだ値を比べ、捨てられた機能を `failed` に出す
- **Rationale**:
  - 定義を持ち歩かず、書くたびに読む。利用者が足したフィールドや GitHub が足した種類の値も、pecot を直さずに扱える（FR-014）
  - Issue fields を別の要求にするのは、権限の不足を GitHub の 403 の文で返すため（FR-020）。作成の要求の `issue_field_values` は、権限が無いと捨てられ、理由が残らない
- **Alternatives considered**:
  - 名前と値の連想配列（`{"Area": "x"}`）: 同じ名前の曖昧さ（FR-019）を表せない
  - GraphQL の `createIssue` に移す: `issueFields` を持つが、REST の作成と同じ範囲で、移す理由が無い
  - Issue fields を作成の要求に入れ、応答の `issue_field_values` と比べる: 要求は 1 回減るが、理由は「GitHub が捨てた」としか書けない
  - Issue fields を GraphQL の `setIssueFieldValue` で書く: REST と同じく GA だが、REST で足りる

## R8. 使えることの担保（B）

- **Decision**:
  - GitHub の公開スキーマ（GraphQL の SDL）と REST の OpenAPI（`github/rest-api-description` の `api.github.com.json`）から、Issue の機能に関わる部分だけを抜いた写しを、`plugins/pecot-workflow/interface/github-issue-surface.json` に置く
  - 抜く部分は次のとおり
    - `CreateIssueInput`・`UpdateIssueInput` の項目
    - `ProjectV2FieldType`・`ProjectV2CustomFieldType`・`IssueFieldDataType` の値
    - `ProjectV2FieldValue` の項目
    - Issue を対象にする mutation（`addSubIssue`・`addBlockedBy` など）の名前
    - REST の `POST /repos/{o}/{r}/issues` の本文の項目
  - 抜き出しと差の計算は、domain の `plugins/pecot-workflow/cli/src/domain/issue-surface.ts` に置く。
    SDL と OpenAPI の取得と、差の Issue の作成は infra に置く（憲章の I と VI）
  - `plugins/pecot-workflow/cli/scripts/github-surface/` の `extract.ts`（写しを作り直す）と `drift.ts`（定期の比べ）は、引数を読んで上を呼ぶだけにする。
    今の `export-interface.ts` が、比べる処理を `libs/interface-spec` の domain から呼ぶのと同じ形
  - 担保の一覧 `plugins/pecot-workflow/interface/issue-coverage.yaml` に、写しの各項目を `supported`（扱うコードの名前）か `excluded`（理由）として書く
  - PR の CI のテスト（vitest）は、次の 2 つを確かめる
    - 写しの各項目が一覧にあること
    - `supported` の項目が、CLI の機能の登録（`ATTRIBUTE_HANDLERS`）に実在すること
  - 定期の確かめは、新しい workflow `issue-surface-drift.yml` で行う
    - `pecot-board-sync` の Lambda の dispatch の先に足す
    - workflow は、今の SDL と OpenAPI から抜き出して写しと比べ、差があれば、差の要約の hash を印にした Issue を 1 件起票する
    - 同じ印の開いた Issue があれば作らない
- **Rationale**:
  - SDL は認証なしで取れ、決まった形で、非推奨や削除の予定も載る。トークンによって結果が変わる introspection より安定している
  - Group by などの REST だけの機能は、OpenAPI で補う
  - PR の CI は写しだけを読み、GitHub に取りに行かない（FR-023）
  - 定期の起動は、このリポの決まりで Lambda の Scheduler から行う（memory）。Lambda は workflow を dispatch するだけなので、トークンの権限は変えない
- **Alternatives considered**:
  - Actions の cron: このリポでは、定期の起動を Lambda に寄せている
  - Lambda の中で比べる: Lambda のトークンは `actions: write` だけで、Issue を作れない。比べる処理をリポのテストと共有できない

## R9. 棚卸しの一覧（B）

- **Decision**:
  - `plugins/pecot-workflow/docs/github-features.md` に、GitHub Projects と Issue の機能ごとの一覧を書く。機能は公式の文書の目次から拾う
  - 各機能について、pecot の今の使い方・使うか使わないか・理由・関連する Issue を書く
  - 独自の仕組みで GitHub に同じ役割のものがあれば、不適合として起票する（FR-027）
  - 「使う」としたものは、準備の操作か w-onboarding の案内に入れる
- **Rationale**: 保守者が読む文書で、配布物の動きは決めない。CONTRIBUTING からリンクする
- **Alternatives considered**: spec の research に置く。spec は機能の計画の記録で、実装の後に保守しないので、保守の一覧に向かない

## R10. 標準との適合

| 項目 | 判断 |
|---|---|
| フィールドの改名・作成・削除 | GraphQL の公式の mutation だけを使う |
| ビュー | REST の公式の作成の API。Group by を GraphQL で設定できない点は、仕様の制約として受け入れる |
| Issue fields | GA の REST・GraphQL を使う。preview の項目（Issue の `statusId` など）は `excluded`（preview）として一覧に残す |
| MCP | 新しいツールにも `inputSchema`・`outputSchema` を付ける。`attributes` の値は JSON Schema の `anyOf`（string・number・string の配列・null。zod の `z.union` が出す形）で表す |
| 独自の項目 | GitHub に置き場所のある情報（担当者・マイルストーン・Issue type など）を、pecot の frontmatter や設定に独自に持たない。起票の frontmatter の `attributes` は、MCP の入力と同じ名前で受けるだけにする |

不適合として残すものは無い。
