# Feature Specification: pecot のフィールドを pecot-status・pecot-lane に整理し、Issue に付くすべての機能を MCP から使える

**Feature Branch**: `feat/breakdown-board-area-lanes/592`

**Created**: 2026-11-17

**Status**: Draft

**Input**: Epic pecotcraft/pecot#542。分解のタスクは #592。この spec は、互いに独立した 2 つの話を扱う。

- **A. pecot のフィールドの整理**: 進行の欄 `pecot-workflow-<suffix>` を `pecot-status` に改名する。pecot がボードに持つフィールド `pecot-priority`・`pecot-size` を廃止し、代わりに領域を表す `pecot-lane` を足す。領域ごとのレーンでボードを見て、偏りに気づけるようにする
- **B. Issue の機能を使える担保**: pecot-workflow の MCP ツールとそれを呼ぶスキルから、Issue に付く機能のすべて（今後 GitHub に増えるもの・利用者が足すフィールドを含む）を起票・表示・更新で使えることを担保する。使うかどうかはプロジェクトが決め、pecot は強制しない。あわせて、pecot が GitHub Projects の機能を使い切れていない点を見直す

## 背景

| 場面 | 今の姿 |
|---|---|
| 進行の欄の名前 | `pecot-workflow-<suffix>`（このリポでは `pecot-workflow-pecotcraft`）。接尾辞のぶん名前が長く、ほかの pecot のフィールドと形がそろわない |
| pecot のフィールド | ボードの準備で `pecot-priority`（High・Medium・Low）と `pecot-size`（XS・S・M・L）を作り、起票で値を入れる（w-quick は常に medium・s）。security tracker は重大度から `pecot-priority` を入れる。どの一覧・判断・並べ替えも値を読まず、実質使っていない |
| 領域の偏り | 2026-11-17 には、Ready から In Review までがほぼ pecot-workflow だった。pecot-visual の Epic（#37・#39・#43）と pecot-tools の Epic（#48）は、すべて Pending にある |
| 領域の表し方 | ラベルしか無い。GitHub Projects はラベルでグループ化できないので、領域のレーンを作れない。Slice by やフィルタで絞れるが、開いて操作しない限り偏りは見えない |
| pecot の操作と領域 | 起票（`issue_create`）・`board_sync`・`board_show`・w-active の一覧は、領域を扱わない。手で付けても、付け忘れに気づく仕組みが無い |
| 起票で指定できる Issue の機能 | Issue type・ラベル・`pecot-priority`・`pecot-size`・Status・親（sub-issue）・blocked-by だけ。担当者・マイルストーン・利用者が足したボードのフィールド・Issue fields は指定できない |
| 表示と更新 | `issue_show`・`board_show` も上と同じ範囲しか出さない。起票の後に MCP から変えられるのは、Status・blocked-by など一部だけ |
| 機能が増えたとき | GitHub に機能が増えるか、利用者がフィールドを足すたびに、CLI・MCP の入力・スキルを直さないと使えない。使えない機能が増えても、気づく仕組みが無い |
| GitHub 側の今 | Issue fields（Issue そのものに付くフィールド。single select・multi select・text・number・date）が、組織では 2026-07-02 に、個人のアカウントでは 2026-11-11 に GA になった。ボードの列として出せ、Group by・フィルタにも使える。Projects のビューは、REST API で Group by を指定して作れる |

この spec で使う言葉:

| 言葉 | 意味 |
|---|---|
| pecot のフィールド | pecot がボードの準備で作り、自分の処理で読み書きするボードのフィールド。名前は `pecot-` で始まる |
| `pecot-lane` | pecot のフィールドの 1 つ。single select で、作業の領域（プラグイン・チーム・サービスなど）を表す。値は利用者が決める |
| 領域のレーン | ボードのビューを `pecot-lane` で Group by したときの、値ごとの行 |
| ボードのフィールド | GitHub Projects のボードが持つフィールド。組み込みのもの（Status など）・pecot のフィールド・利用者が足したものがある |
| Issue fields | GitHub の組織か個人のアカウントが定める、Issue そのものに付くフィールド。ボードに関係なく、その持ち主のすべての Issue に付く |
| Issue の機能 | Issue に付く情報のすべて。ボードのフィールド・Issue fields・担当者・マイルストーン・ラベル・Issue type・親子・依存（blocked-by）を含む |
| 属性の定義 | Issue の機能の 1 つの、名前・種類（single select・text・number・date・iteration など）・取りうる値。ボードか組織に問い合わせて得る |

## Clarifications

### Session 2026-11-17

- Q: 領域のフィールドを、ボードのフィールドと組織の Issue fields のどちらに置くか → A: ボードのフィールドに置く。個人のアカウントのボードでも動くようにする（FR-002）
- Q: 領域のフィールドの名前 → A: `pecot-lane`。pecot のフィールドとして、`pecot-priority`・`pecot-size` の代わりに足す（FR-001）
- Q: 名前の長い進行の欄 `pecot-workflow-<suffix>` をどうするか → A: `pecot-status` に改名する（FR-029〜FR-032）
- Q: 改名するとき、`project_create`・`project_init` の必須の入力 `suffix` も無くすか → A: 入力ごと無くす。設定ファイルの名前などは、ボードの情報から決める。既存の設定は移行する（FR-029a・FR-031）
- Q: GitHub に Issue の機能が増えたことに、いつ・どう気づくか → A: リポに GitHub の API のスキーマの写しを置き、PR の CI は写しと比べる。Lambda の Scheduler から起動する定期の実行が、今のスキーマと写しを比べ、差があれば Issue にする（FR-023・FR-023a）
- Q: 既存のボードの移行（`pecot-status` への改名と、`pecot-priority`・`pecot-size` の削除）は、どの操作で行うか → A: 利用者がボードを整える操作を打ったときだけ、両方を行う。削除は、消すフィールドを示して確認を取ってから行う。ほかの操作は旧い形でも動き、移行の手順を示す（FR-010・FR-030・FR-031）
- Q: `pecot-priority`・`pecot-size` をどうするか → A: 廃止する（FR-008〜FR-011）
- Q: 「Issue の機能をすべて使える」とは、すべてを使わせることか → A: 違う。pecot が担保するのは、すべての機能を MCP から使えることだ。どれを使うかはプロジェクトが決め、pecot は強制しない。A の話とは別の話として扱う（FR-013〜FR-024）

## User Scenarios & Testing *(mandatory)*

### A. pecot のフィールドの整理

### User Story 1 - 領域ごとのレーンでボードを見て、空の領域に気づく (Priority: P1)

保守者は、ボードを開くと、作業が `pecot-lane` の値ごとのレーンに分かれて見える。Ready から In Review までのレーンのうち、pecot-visual と pecot-tools が空であることが、開いただけで分かる。Status のレーンと同じく、値のクリックでの絞り込み・Slice by・フィルタが使える。

**Why this priority**: Epic #542 の目的そのもの。ボードに領域が無ければ、起票で入れる・一覧で分けるのどれも意味を持たない。

**Independent Test**: pecot でボードを準備し、`pecot-lane` と領域のレーンのビューがあることを確かめる。Issue に `pecot-lane` を付けてビューを開き、値ごとのレーンが出て、値の無い Issue は「値なし」のレーンに入ることを確かめる。

**Acceptance Scenarios**:

1. **Given** ボードに `pecot-lane` が無い、**When** 利用者が pecot でボードを準備する（新しく作る・既存のボードを整える）、**Then** `pecot-lane` が足され、利用者が決めた値（このリポでは `pecot-workflow`・`pecot-visual`・`pecot-tools`・`repo`）を持つ
2. **Given** `pecot-lane` がある、**When** 利用者が pecot でボードを準備する、**Then** 領域のレーンのビューが用意される。ビューを用意できないときは、手で作る手順が示される
3. **Given** 領域のレーンのビューがある、**When** 保守者がそれを開く、**Then** 値ごとのレーンに Issue が分かれ、Status と同じ操作で絞り込める
4. **Given** 利用者が値を決めていない、**When** pecot でボードを準備する、**Then** pecot は値を勝手に決めず、値を決めるよう案内する

---

### User Story 2 - pecot で起票した Issue に領域が入り、入っていない Issue に気づける (Priority: P1)

開発者がスキル（w-quick・w-ready・w-issueize・w-backlog）で起票すると、Issue に `pecot-lane` が入る。手で作った Issue など、`pecot-lane` の無い Issue があれば、ボードの同期のときに pecot が知らせる。

**Why this priority**: 領域の入っていない Issue はレーンに出ないので、User Story 1 だけでは偏りを正しく見られない。

**Independent Test**: 各スキルで 1 件ずつ起票し、`pecot-lane` が入ることを確かめる。`pecot-lane` の無い Issue を 1 件置き、同期で知らされることを確かめる。

**Acceptance Scenarios**:

1. **Given** `pecot-lane` のあるボード、**When** スキルで起票する、**Then** 起票した Issue に `pecot-lane` が入る。値は起票の内容から決め、決められないときは利用者に確かめる
2. **Given** 親の Epic に `pecot-lane` がある、**When** その下にタスクを起票する、**Then** 指定が無ければ、タスクは親と同じ値になる
3. **Given** `pecot-lane` の無い Issue がボードにある、**When** ボードを同期する、**Then** pecot はその Issue を挙げて知らせる。同期は止まらない
4. **Given** ボードに無い `pecot-lane` の値を指定した、**When** 起票する、**Then** Issue を作る前に、無い値であることと取りうる値が示される

---

### User Story 3 - 一覧が領域ごとに分かれて出る (Priority: P2)

開発者が `board_show` でボードを見るときと、w-active で着手できるタスクを選ぶときに、一覧が `pecot-lane` の値ごとに分かれて出る。どの領域に着手できるタスクが無いかが、一覧から分かる。

**Why this priority**: ボードの画面を開かずに、エージェントとの対話の中で偏りに気づける。User Story 1・2 が先に要る。

**Independent Test**: `pecot-lane` の値が異なる Ready のタスクを置き、`board_show` と w-active の一覧が値ごとに分かれ、値の無いタスクが別の組に出ることを確かめる。

**Acceptance Scenarios**:

1. **Given** `pecot-lane` のあるボード、**When** `board_show` を使う、**Then** 各 Issue の `pecot-lane` が出て、領域ごとに分けて読める
2. **Given** `pecot-lane` のあるボード、**When** w-active で着手するタスクを選ぶ、**Then** 候補が領域ごとに分かれて出る。着手できるタスクの無い領域も、空であることが分かる
3. **Given** `pecot-lane` の無いボード、**When** `board_show` と w-active を使う、**Then** これまでと同じ一覧が出て、止まらない

---

### User Story 4 - `pecot-priority`・`pecot-size` を廃止する (Priority: P1)

pecot は `pecot-priority`・`pecot-size` を持たない。ボードの準備で作らず、起票で求めず、値も入れない。保守者は、値を入れても何にも使われないフィールドを、ボードで見ることも、起票で決めることもなくなる。

**Why this priority**: `pecot-lane` への入れ替えの片側。同じ変更で入れ替えると、利用者の移行が 1 回で済む。

**Independent Test**: 新しく準備したボードに `pecot-priority`・`pecot-size` が無く、各スキルと MCP の起票がそれを求めず、入れないことを確かめる。2 つを持つ既存のボードでも、pecot が止まらないことを確かめる。

**Acceptance Scenarios**:

1. **Given** 新しいボード、**When** pecot でボードを準備する、**Then** `pecot-priority`・`pecot-size` は作られない
2. **Given** スキルか MCP、**When** 起票する、**Then** `pecot-priority`・`pecot-size` は求められず、入れられない
3. **Given** `pecot-priority`・`pecot-size` を持つ既存のボードと、それを書いた既存の設定・テンプレート、**When** ボードを整える操作のほかの、pecot の各操作を使う、**Then** 止まらない。ボードを整える操作で移行する手順が示される
4. **Given** security tracker、**When** アラートから Tracker を作る・直す、**Then** 重大度は本文に出し、`pecot-priority` には入れない
5. **Given** `pecot-priority`・`pecot-size` を持つ既存のボード、**When** 利用者がボードを整える操作を打つ、**Then** 消すフィールドが示され、利用者が確認したときだけ 2 つのフィールドが消える。確認しなければ、何も消えない

---

### User Story 4b - 進行の欄を `pecot-status` に改名する (Priority: P1)

進行の欄（Backlog・Pending・Blocked・Ready・Active・In Review・Archived）のフィールドの名前は、`pecot-workflow-<suffix>`（このリポでは `pecot-workflow-pecotcraft`）から `pecot-status` になる。ボードの画面・Group by・フィルタで、短い名前で扱える。

**Why this priority**: pecot のフィールドの名前を `pecot-<役割>` の短い形にそろえる。`pecot-lane` を足すのと同じ変更で改名すると、利用者の移行が 1 回で済む。

**Independent Test**: 新しく準備したボードの進行の欄が `pecot-status` であることを確かめる。`pecot-workflow-<suffix>` を持つ既存のボードを整えると `pecot-status` に改名され、Issue の値が失われず、pecot の各操作が改名の前と同じに動くことを確かめる。

**Acceptance Scenarios**:

1. **Given** 新しいボード、**When** pecot でボードを準備する、**Then** 進行の欄は `pecot-status` という名前で作られる
2. **Given** `pecot-workflow-<suffix>` を持つ既存のボード、**When** pecot でボードを整える、**Then** そのフィールドが `pecot-status` に改名され、各 Issue の値と選択肢はそのまま残る
3. **Given** 改名の前のボードと設定、**When** 改名の前に pecot の各操作を使う、**Then** 止まらず、改名の手順が示される
4. **Given** 改名の後のボード、**When** pecot の各操作（起票・移動・同期・一覧・判定）を使う、**Then** 改名の前と同じ結果になる

---

### B. Issue の機能を使える担保

### User Story 5 - Issue に付くすべての機能を、MCP から使えることが担保されている (Priority: P1)

開発者のエージェントは、pecot-workflow の MCP ツールで、Issue に付く機能のどれでも、起票のときに指定し、読み、後から変えられる。利用者がボードにフィールドを足したときや、GitHub に Issue の機能が増えたときも、pecot を直さずに、その機能を名前で指定できる。

pecot が担保するのは「使える」ことだ。どの機能を使うかはプロジェクトが決め、pecot は強制しない。指定しなかった機能は、起票で空のままにする。

使えることは、心がけでなく仕組みで担保する。GitHub に pecot が扱えない機能が増えたら、pecot が知らせ、保守者は CI で気づける。

**Why this priority**: 利用者の大きな目標。担保の仕組みが無ければ、GitHub の機能が増えるたびに、気づかないまま使えない機能が残る。

**Independent Test**: 検証用のボードに、pecot が知らない名前のフィールド（single select・text・number・date・iteration を 1 つずつ）を足し、MCP から起票時の指定・表示・更新ができることを確かめる。担当者・マイルストーン・Issue fields も同じく確かめる。pecot が扱う範囲から 1 つの機能を外した状態で、差の確かめがその機能を挙げることを確かめる。

**Acceptance Scenarios**:

1. **Given** ボードに利用者が足したフィールドがある、**When** MCP で起票し、そのフィールドの名前と値を渡す、**Then** 起票した Issue にその値が入る
2. **Given** 起票済みの Issue、**When** MCP で機能の値を変える・外す、**Then** Issue とボードに反映される
3. **Given** Issue、**When** MCP で Issue を表示する、**Then** 値の入っている機能がすべて、名前と値で出る
4. **Given** 機能の種類に合わない値（数値のフィールドに文字・無い選択肢・形式の違う日付・無い担当者・無いマイルストーン）、**When** MCP で指定する、**Then** 書き込む前に、どの機能のどの値が合わないかと、取りうる値が示され、何も書き込まれない
5. **Given** 利用者が、どんな機能と値が使えるかを知りたい、**When** MCP で問い合わせる、**Then** そのボードと組織で使える機能の定義（名前・種類・取りうる値）が出る
6. **Given** ボードにも組織にも無い名前、**When** MCP で指定する、**Then** 無い名前であることが示され、似た名前があれば挙がる
7. **Given** ボードに多くのフィールドがある、**When** 一部の機能だけを指定して起票する、**Then** 指定した機能だけが入り、ほかは空のまま。指定しなかったことで起票が止まらない
8. **Given** GitHub に、pecot が扱えない種類の機能が増えた、**When** pecot がその機能を持つボードや Issue を扱う、**Then** 扱えない機能の名前と種類が知らされ、ほかの処理は続く
9. **Given** 保守者、**When** pecot が扱える範囲と GitHub の仕様の差を確かめる、**Then** pecot が扱えない Issue の機能が一覧で出る。差があれば、CI で気づける

---

### User Story 6 - GitHub Projects の機能の使い残しを棚卸しし、使うべきものを使う (Priority: P3)

保守者は、GitHub Projects と Issue の機能のうち、pecot が使っていないもの（ビュー・Group by・Slice by・組み込みの自動化・Iteration・Insights など）の一覧と、それぞれを使うか・使わないかの判断と理由を読める。使うと決めたものは、pecot のボードの準備か案内に入っている。

**Why this priority**: 「機能の活用の改善」の土台。User Story 5 で使えるようにした後で、どれを pecot の流れに入れるかを決める。

**Independent Test**: 棚卸しの一覧に、GitHub の公式の文書にある Projects と Issue の機能が漏れなく載り、各機能に判断と理由があることを確かめる。「使う」とした機能が、新しく準備したボードに入っているか、案内に出ることを確かめる。

**Acceptance Scenarios**:

1. **Given** 棚卸しが済んだ、**When** 保守者が一覧を読む、**Then** 各機能について、pecot の今の使い方・使うか使わないか・理由が分かる
2. **Given** 「使う」とした機能、**When** 利用者が pecot でボードを準備する、**Then** その機能が設定されるか、設定する手順が示される
3. **Given** pecot が独自に持っている仕組みで、GitHub の機能に同じ役割のものがある、**When** 棚卸しをする、**Then** その仕組みは不適合として挙がる

---

### Edge Cases

- ボードに `pecot-lane` が無い、または値が 1 つも無い: 起票・同期・一覧はこれまでどおり動き、`pecot-lane` に関する処理だけを飛ばす。止まらない
- 利用者が `pecot-lane` の値を消した・名前を変えた: その値を持っていた Issue は「値なし」として扱い、同期で知らせる
- 既存のボードに `pecot-priority`・`pecot-size` が残っている: ボードを整える操作のほかは、pecot は読まず、書かず、止まらない
- 同じ名前の機能が、ボードのフィールドと Issue fields の両方にある: どちらを指すかを示し、利用者がどちらかを選べる。黙ってどちらかに書き込まない
- Issue fields を 1 つも定めていない持ち主: ボードのフィールドだけで動く
- Issue fields の仕様が変わった（種類の追加・削除の予定など）: Issue fields を使う処理のうち、合わなくなったものだけが止まり、理由が示される。ほかの処理は続く
- 書き込めない機能（GitHub が計算するもの・読み取り専用のもの）を指定した: 書き込めないことが示され、何も書き込まれない
- ビューを API で作れない（権限が無い・API が無いボード）: 手でビューを作る手順を示し、ほかの準備は続ける

## Requirements *(mandatory)*

### Functional Requirements

#### A-1. `pecot-lane`

- **FR-001**: ボードを準備する操作（新しく作る・既存のボードを整える）は、pecot のフィールド `pecot-lane`（single select）を用意しなければならない。値は利用者が決め、pecot は勝手に決めてはならない
- **FR-002**: `pecot-lane` は、ボードのフィールドに置かなければならない。組織の Issue fields には置かない
- **FR-003**: ボードを準備する操作は、`pecot-lane` で Group by した領域のレーンのビューを用意しなければならない。用意できないときは、手で作る手順を示さなければならない
- **FR-004**: 起票するスキル（w-quick・w-ready・w-issueize・w-backlog）は、`pecot-lane` を入れなければならない。値は起票の内容から決め、決められないときは利用者に確かめる。親の Epic に値があり指定が無ければ、親と同じ値にする
- **FR-005**: ボードの同期は、`pecot-lane` の無い Issue を挙げて知らせなければならない。知らせても、同期は止めてはならない
- **FR-006**: `board_show` の結果と w-active の候補の一覧は、Issue を `pecot-lane` の値ごとに分けて示さなければならない。着手できるタスクの無い領域も、空であることが分かる形にする
- **FR-007**: `pecot-lane` が無いか値の無いボードでは、起票・同期・一覧は止まってはならない

#### A-2. `pecot-priority`・`pecot-size` の廃止

- **FR-008**: ボードを準備する操作は、`pecot-priority`・`pecot-size` を作ってはならない。pecot の設定は、この 2 つを持ってはならない
- **FR-009**: 起票（スキル・MCP・テンプレート）は、`pecot-priority`・`pecot-size` を求めても、値を入れてもならない。security tracker は、重大度を本文に出し、`pecot-priority` に入れてはならない
- **FR-010**: `pecot-priority`・`pecot-size` を持つ既存のボードと、それを書いた既存の設定・テンプレートで、pecot は止まってはならない。ボードを整える操作は、消すフィールドを示し、利用者の確認を取ってから 2 つのフィールドを消さなければならない。確認が無ければ消してはならない。ほかの操作は消さず、ボードを整える操作で移行する手順を示す
- **FR-011**: このリポのボードから、`pecot-priority`・`pecot-size` を外す

#### A-3. `pecot-status` への改名

- **FR-029**: ボードを準備する操作は、進行の欄を `pecot-status` という名前で作らなければならない。名前にプロジェクトごとの接尾辞を付けてはならない
- **FR-029a**: ボードを作る・準備する操作は、接尾辞（`suffix`）を入力に求めてはならない。設定ファイルの名前など、接尾辞で見分けていたものは、ボードの情報（owner・番号など）から決めなければならない
- **FR-030**: 既存のボードを整える操作は、`pecot-workflow-<suffix>` を `pecot-status` に改名しなければならない。各 Issue の値と選択肢を失ってはならない。改名は、利用者がボードを整える操作を打ったときだけ行い、ほかの操作は改名しない
- **FR-031**: 改名の前のボードと設定で、pecot は止まってはならず、改名の手順を示さなければならない。接尾辞を持つ既存の設定は、新しい形に移行しなければならない
- **FR-032**: このリポのボードの `pecot-workflow-pecotcraft` を、`pecot-status` に改名する

#### A-4. このリポと案内

- **FR-012**: このリポのボードは、`pecot-lane` の値 `pecot-workflow`・`pecot-visual`・`pecot-tools`・`repo` と、領域のレーンのビューを持ち、開いている Issue のすべてに `pecot-lane` が入っていなければならない。w-onboarding と w-help は、`pecot-lane` の値の決め方と、領域のレーンのビューの開き方を案内しなければならない

#### B-1. Issue の機能を MCP で使う

- **FR-013**: MCP の起票は、Issue の機能（ボードのフィールド・Issue fields・担当者・マイルストーン・ラベル・Issue type・親子・依存）を、起票と同時に指定できなければならない
- **FR-014**: 利用者が足したフィールドと、GitHub に今後増える同じ種類の機能は、pecot を直さずに、名前で指定できなければならない。対象の種類は、single select・multi select・text・number・date・iteration
- **FR-015**: MCP で、起票済みの Issue の機能の値を、変える・外すことができなければならない
- **FR-016**: MCP の Issue の表示は、値の入っている機能を、すべて名前と値で示さなければならない
- **FR-017**: MCP で、そのボードと組織で使える機能の定義（名前・種類・取りうる値）を問い合わせられなければならない
- **FR-018**: 値は、書き込む前に、その機能の定義に合うかを確かめなければならない。合わない値・無い名前・書き込めない機能が 1 つでもあれば、何も書き込まず、どの機能のどの値が合わないかと、取りうる値を示さなければならない
- **FR-019**: 同じ名前の機能がボードのフィールドと Issue fields の両方にあるときは、どちらを指すかを利用者が指定できなければならず、指定が無ければ書き込まずに知らせなければならない
- **FR-020**: Issue fields を使えない環境（定めていない持ち主・権限の足りないトークン）では、Issue fields を使う処理だけを止め、理由を示さなければならない。ほかの処理は続けなければならない

#### B-2. 使えることの担保

- **FR-021**: pecot は、Issue の機能の利用を強制してはならない。MCP の起票・更新は、指定された機能だけを書き、指定の無い機能を求めて止まってはならない。どの機能を使うかは、プロジェクトが決める
- **FR-022**: pecot が扱えない種類の機能を持つボード・Issue を扱うときは、その名前と種類を知らせなければならない。ほかの処理は続けなければならない
- **FR-023**: リポに、GitHub の公式の API のスキーマのうち Issue の機能に関わる部分の写しを置かなければならない。PR の CI は、pecot が扱える Issue の機能を写しと突き合わせ、扱えず担保の一覧にも無い機能があれば落ちなければならない。CI は、GitHub に取りに行ってはならない
- **FR-023a**: Lambda の Scheduler から起動する定期の実行が、GitHub の今のスキーマと写しを比べなければならない。差があれば、増えた・変わった機能を挙げた Issue を、このリポに起票しなければならない。同じ差で Issue を重ねて作ってはならない
- **FR-024**: 担保の範囲は、GitHub の公式の API で読み書きできる Issue の機能のすべてとする。範囲から外すものは、外す理由とともに一覧に残さなければならない
- **FR-025**: Issue の機能の扱いは、GitHub の公式の仕様（Projects・Issues・Issue fields）と MCP の仕様の形に従わなければならない。GitHub に置き場所がある情報に、pecot が同じ役割の独自の項目を足してはならない

#### B-3. 機能の棚卸し

- **FR-026**: GitHub Projects と Issue の機能（ビュー・レイアウト・Group by・Slice by・フィルタ・組み込みの自動化・Iteration・Insights・Issue fields・Issue type・sub-issue・依存など）を、公式の文書から一覧にし、pecot の今の使い方と、使うか使わないかの判断と理由を残さなければならない
- **FR-027**: 棚卸しで、GitHub の機能と同じ役割を pecot が独自に持っている仕組みが見つかったら、不適合として挙げ、Issue にしなければならない
- **FR-028**: 棚卸しで「使う」とした機能は、ボードを準備する操作に入れるか、その手順を案内に書かなければならない

### Key Entities

- **pecot のフィールド**: pecot がボードに作り、自分の処理で読み書きするフィールド。この spec の後は `pecot-status`（進行の欄）と `pecot-lane` の 2 つになる。`pecot-priority`・`pecot-size` は無くなる
- **`pecot-lane`**: single select。値は利用者が決める。領域のレーンと、一覧の分け方に使う
- **領域のレーンのビュー**: ボードのビューの 1 つ。`pecot-lane` で Group by する
- **機能の定義**: Issue の機能の名前・種類・取りうる値・置き場所（ボードか組織か）・書き込めるか。ボードと組織に問い合わせて得る。pecot は定義を持ち歩かない
- **機能の値**: ある Issue の、ある機能の値。値なしもありうる
- **担保の一覧**: GitHub の Issue の機能ごとに、pecot が扱えるか、扱わないならその理由を持つ
- **棚卸しの一覧**: GitHub Projects と Issue の機能ごとに、pecot の今の使い方・判断・理由・関連する Issue を持つ

## Success Criteria *(mandatory)*

### Measurable Outcomes

#### A. pecot のフィールドの整理

- **SC-001**: このリポのボードで、領域のレーンのビューを開いてから 10 秒以内に、着手できるタスクの無い領域を言い当てられる
- **SC-002**: pecot の起票するスキルで作った Issue の 100% に、`pecot-lane` が入る
- **SC-003**: `pecot-lane` の無い Issue は、次のボードの同期で 100% 知らされる
- **SC-004**: 新しく準備したボードと、pecot の起票で作った Issue に、`pecot-priority`・`pecot-size` が 1 つも現れない
- **SC-005**: `pecot-priority`・`pecot-size` が残る既存のボードで、pecot の各操作が 100% 止まらない
- **SC-005b**: `pecot-status` に改名した後、各 Issue の進行の欄の値が 100% 改名の前と同じで、pecot の各操作の結果も同じになる

#### B. Issue の機能を使える担保

- **SC-006**: 検証用のボードに pecot が知らない名前のフィールドを 5 種類（single select・text・number・date・iteration）足したとき、pecot を直さずに、5 種類すべてを起票時に指定・表示・更新できる
- **SC-007**: GitHub の公式の API で読み書きできる Issue の機能のうち、100% が、MCP から使えるか、外す理由とともに担保の一覧に載っている
- **SC-008**: pecot が扱う範囲から 1 つの機能を外すと、差の確かめがそれを挙げて CI が落ちる
- **SC-008a**: 写しに無い機能を GitHub のスキーマに足した状態を定期の実行に与えると、その機能を挙げた Issue が 1 件だけできる
- **SC-009**: 定義に合わない値を指定した操作の 100% で、何も書き込まれず、合わない機能と取りうる値が示される
- **SC-010**: 機能を 1 つも指定しない MCP の起票が、どのボードでも 100% 止まらずに済む
- **SC-011**: 棚卸しの一覧が、GitHub の公式の文書にある Projects と Issue の機能をすべて含み、各機能に判断と理由がある

## Assumptions

- A と B は独立している。A は B の汎用の仕組みを待たずに進められ、B は `pecot-lane` を前提にしない
- 領域のレーンは、GitHub Projects の画面の Group by で実現する。pecot は独自の画面を作らない
- ビューは、GitHub の公式の API で Group by を指定して作れる（REST の Projects views）。作れない環境では手順を示す
- `pecot-lane` の値は、このリポではプラグインとリポ全体（`repo`）の 4 つ。ほかの利用者は自分で決める
- 起票で `pecot-lane` の値を決めるのはスキル（エージェント）で、CLI は値の妥当性だけを確かめる
- 「Issue の機能のすべて」の対象は、GitHub の公式の API で読み書きできるものに限る。画面からしか触れないものは、棚卸しに載せて判断する
- 組み込みの Status は、今の「札」（Todo・Needs Attention）としての使い方を変えない。進行の欄は `pecot-status` で持つ
- GitHub Copilot CLI だけの不具合は、この spec の対象外にする
