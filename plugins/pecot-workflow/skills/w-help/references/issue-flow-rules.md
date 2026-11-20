# Issue/PR フロー基本ルール

`/pecot-w:w-quick` / `/pecot-w:w-ready` / `/pecot-w:w-issueize` / `/pecot-w:w-backlog` が対象。
これらの Issue 起票に共通する、判定ルールを定める。
判定ルールは 4 つあり、投稿先リポ・親 Epic 参照・タイトル連番・テンプレート選択を扱う。
着手前のセッションスコープ前提（§5）と、着手後の変更対象リポジトリ限定（§6）も、このファイルが定義元になる。
AI は推測で埋めない。ここで定義される手順に従い、ユーザー指示とツールの結果を組み合わせて決定する。

## 1. `repository` の決定

Epic と、task / bug / tracker で挙動が異なる。
表の `issue_create`・`tracker_sync` は、pecot-workflow の MCP ツールの名前。

| 種類 | 投稿先の決まり方 |
|------|-----------------|
| Epic | `aggregation_repo` が設定済みなら **そこに集約する**。`repo` 未指定 + `repository: ""` でも `issue_create` が自動補完。例外時のみ `repo: "<owner/repo>"` で明示（警告を出して作成は続行） |
| 通常 Issue（task / bug） | **実装が行われるリポ** を指定する。Epic が aggregation_repo に置かれていても、その配下のサブタスクは aggregation_repo に作らない |
| Tracker | task と同じく `repo` が必須で、aggregation_repo に寄せない。security alert の Tracker は `tracker_sync`（`source: "security"`）が実装リポに立てる |

Epic は「プロジェクト全体の進捗把握 / 親子追跡」のため集約リポに寄せる。一方サブタスクは
実装コードが置かれるリポに作ることで、PR や branch と同じ場所で追跡できる。両者を混同すると
aggregation_repo が雑多な実装サブタスクで埋まり、Epic の俯瞰性が失われる。

ユーザー指示が無い時の確認手順:

1. pecot-workflow の MCP ツール `project_get` を使い（`key: "aggregation_repo"`）、集約リポを取得
2. 集約リポと実装リポが異なる場合、サブタスクは実装リポ側を `repo` で指定する
3. どちらに作るべきか判断材料が無い場合は AskUserQuestion で確認する（推測で埋めない）

pecot-workflow の MCP ツール `issue_create` が失敗する代表ケース:

- Epic で `repo` 未指定かつ `aggregation_repo` も未設定（決定不能）
- 通常 Issue（task / bug / tracker）で `repository: ""` のまま投稿（必須フィールド欠落）

## 2. `parent_epic` の指定

受理形式は 2 通り。

| 形式 | 解釈 |
|------|------|
| `owner/repo/N`（主軸形式・推奨） | そのまま該当リポの Issue #N を指す |
| 整数 `N` 単体 | `aggregation_repo` の Issue #N として解決。`aggregation_repo` 未設定時は task repo にフォールバック |

クロスリポで親 Epic を参照する場合は **full path 必須**。集約リポに置いた Epic の配下に
別リポのサブタスクを作るケース（典型的な pecot 運用）では `parent_epic: acme-labs/aist-roadmap/123`
のように書く。整数 `123` だけだと aggregation_repo 解釈になるため、サブタスクの task repo と
aggregation_repo が同じ場合のみ意図通り動く。

整数指定で aggregation_repo と task repo が異なっても、CLI は何も出さずに aggregation_repo の Issue #N として解決する。
確認の通知やエラーは出ないので、task repo の Issue を指したいときは `owner/repo/N` で書く。

`parent_epic` は、フロントマターに書いても引数で渡しても、次の順で整える。

- 数字だけなら整数（Issue 番号）にする
- それ以外は `owner/repo/N` の参照として解決する。解決できない値は使い方の誤りとして止まる
- 空なら未指定にする。引数では、前後の空白を落としてから空かを見るので、空白だけの値も未指定になる。フロントマターでは `""` だけが未指定で、空白だけの値は未指定にならず、解決できない値として止まる

## 3. `order` とタイトル prefix

`order` は、親 Epic の配下のサブタスクの通し番号で、1 以上の整数。`order` を指定するには `parent_epic` が要る。
`order` を省くと、CLI が既存のサブタスクの最大の次から、ファイルの順に振る。段（依存グラフの層）は表さない。前後関係は、前提（`blocked_by`）で書く。
枝の文字（`parallel`）は使えない。書くと止まる。枝の文字の付いた既存の番号（`18a` など）は、数字の部分で数える。

タイトルは CLI が自動生成する。
`{order}` は、2 桁に満たなければ 0 で埋めた値（例: `3` は `03`）を指す。形式は次のとおり。

```
[Task] #{epic}-{order}: <title>
[Bug]  #{epic}-{order}: <title>
```

`order` の決定:

- 同じ Epic に対する既存サブタスク（OPEN / CLOSED 問わず）を CLI が確かめる。
  明示した `order` が重複すれば、失敗する
- 再利用はできない（CLOSED でも空き番号にしない）
- 省いたファイルの番号は、既存のサブタスクの最大の番号と、同じ一括で明示した番号の最大の、次から振る。確認は CLI が行う

### 前提（`blocked_by`）と種類

前提は、Issue ファイルの `blocked_by` に書く。1 要素が 1 つの前提で、次のキーを持つ。

| キー | 内容 |
|---|---|
| `issue` | 必須。同じ一括投稿のファイルのキー（ファイル名から拡張子を除いたもの）、または `owner/repo/N` |
| `wait` | `stack`（既定）か `merge` |
| `reason` | `wait: merge` のとき必須。前提の表の `理由` の文をそのまま写す。改行しない |

- 前提にされるファイルを、それを待つファイルより前に並べる。後ろを指す前提と輪は止まる
- `stack`（積める）は、前提の変更を、手元のブランチか試験環境で動かして、実装と確認ができる前提。前提の PR の上に積んで着手できる
- `merge`（マージを待つ）は、前提の変更が開発ブランチに入っていないと、手元のブランチと試験環境のどちらでも、実装か確認ができない前提。開発ブランチは config の `develop_branch`（trunk-based では main）。既定のブランチから配られるもの（action・公開したパッケージ）を使うときや、リリースの後の実物で確かめるときが当たる
  - CLI が、本文の末尾に `## Waits for merge` の節を足す。本文には手で書かない
- 試験環境は、開発ブランチに入れる前の変更を動かして確かめる場所。プロジェクトの文書に、その場所で動かす手順があるときだけ使う。無いときは、手元のブランチだけで判断する
- `status` は、省くと CLI が置く。前提があれば `Blocked`、無ければ `Ready`
- 投稿の後の前提の見直しは、利用者が決める。エージェントの判断で前提を外さない

タイトル prefix（`[Task]` / `[Bug]` / `[Epic]` / `[Tracker]`）は CLI が type から自動で付ける。
ユーザー入力のタイトルに先頭で同じ prefix が入っていれば剥がしてから付け直す。

## 4. テンプレート選択

テンプレートの場所: `cli/templates/issue/{task,bug,epic,tracker,task-implement}.md`

スキル ↔ テンプレート対応:

| スキル | テンプレート | 用途 |
|--------|-------------|------|
| `/pecot-w:w-backlog` | `epic.md` | Epic を 1 件作成し Backlog 配置 |
| `/pecot-w:w-ready` | `task.md` / `bug.md` | Epic または Tracker 配下のサブタスクを 1 件作成し、前提に応じて Ready か Blocked に配置 |
| `/pecot-w:w-issueize` | `task-implement.md`（または `task.md`） | 計画ファイル（speckit の tasks.md 等）の各フェーズを一括 Issue 化 |
| `/pecot-w:w-quick` | `task.md` / `bug.md` | ユーザー指示が来た直後に小タスクを Issue 化 + ブランチ作成まで一気に進める |

`task.md` / `bug.md` の使い分け:

- `task.md`: 新機能・改善・リファクタ・タスク追加など、**達成したい状態** が主軸
- `bug.md`: 既存挙動が期待値と乖離している事象の修正。**Problem（Expected / Actual を対置する表 + Repro）** が主軸

`tracker.md` は、複数の作業を束ねる Tracker を `issue_create` で起こすときのテンプレで、Backlog に置く。
security alert の Tracker は、このテンプレを通らない。本文は pecot-workflow の MCP ツール `tracker_sync` が作る。

`task-implement.md` は w-issueize 固有の「実装フェーズを順に展開する」フォーマットで、
通常の単発起票では使わない。

各テンプレ本文の `<!-- フィールド: -->` ブロックには、このファイルへの参照行が入っている。
このファイルの場所は `skills/w-help/references/issue-flow-rules.md`。
テンプレートの resource を写したファイルを見れば、AI は判定基準に辿り着ける。

### 起票時の既定 status

本節は §4「テンプレート選択」の一部で、各テンプレで起票したときの既定 status を扱う。

計画起票（`issue create` を使う w-backlog / w-ready / w-issueize）は、型の既定の status で起票する。task/bug のテンプレは `status` を持たず、置く列を CLI に任せる。
既定は task/bug=ready（ファイルに `blocked_by` があれば blocked）、epic=backlog、tracker=backlog。
CLI は、#669 から型既定以外の status を拒否する。
これらは未着手の置き場であり、着手時に `session start` がボード Status を active に設定する。

`issue create` の `freeform` も、task/bug を型の既定の status で起票する。
即着手フロー（w-quick）は、起票の直後に `session start` を呼び、`session start` がボード Status を active にする。
active を設定する担い手は、どの起票でも `session start` だけ。

## 5. セッションスコープ（着手前の前提）

pecot は **1 WT = 1 セッション = 1 Issue = 1 リポ** を前提に状態を持つ。並行作業は別 WT で行う。

作業中の Issue の求め方:

- git の remote（origin、無ければ最初）のリポと、ブランチ名の末尾の `/<番号>` から求める。ファイルには記録しない
- ブランチ名は、pecot-workflow の MCP ツール `session_start` が `<名前>/<Issue番号>` の形で作る
- remote が無い、または末尾が番号でない（`main` など）ときは、作業中の Issue は無い。ボード Status 列の Active とは別レイヤ。詳細は [`flags.md`](./flags.md)。

ツールのガード（この表が最終の基準）は次のとおり。

| 違反 | 検出箇所 | 結果 | バイパス（入力） |
|------|----------|----------|----------|
| CWD の remote と Issue ref の owner/repo 不一致 | `session_start` の冒頭 | 止まり、対象リポの worktree でセッションを始め直すよう案内する | なし（対象リポの worktree で始め直す） |
| Issue の判定が blocked | 同上 | 止まり、前提ごとの状態と直し方の行（`issue unblock ...`）を示す | なし（前提を見直す） |
| 前提を読めない・判定できない | 同上 | 止まり、読めなかった理由を示す（開発ブランチが原因なら設定の直し方の行も） | なし（エラーの文を利用者に示す） |
| 積む先のブランチが判定の後に無くなった | `session_start` のブランチ作成前 | 止まり、無くなったブランチを示す | なし（判定をやり直す） |
| `--base` が判定の積む先と違う（stackable のときだけ比べる） | 同上 | 止まり、食い違いを示す | `--base` を外す |

状況を着手前に把握したいときは、pecot-workflow の MCP ツール `session_show` を使う。作業中の Issue と、その OPEN/CLOSED が分かる。

未コミット差分の扱いはツールのガード対象外（git status の判断は AI / 人間に委ねられる）。`git status` で前 Issue 由来の差分が残っていれば commit / stash / 破棄で clean にしてから着手する。

関連: [`w-worktree-add/SKILL.md`](../../w-worktree-add/SKILL.md) / [`w-merge/references/worktree-handling.md`](../../w-merge/references/worktree-handling.md) / [`flags.md`](./flags.md)。

## 6. 変更対象のリポジトリ限定（越境ガード）

計画・実装で変更するファイルは、作業中の worktree の remote のリポ内に限定する。
§5 が「着手してよい状態か」を扱うのに対し、本節は着手後に「どこまで触ってよいか」を扱う。

判定手段:

- git の remote（origin、無ければ最初）の owner/repo を見る
- `session_show` を使って、作業中の Issue と状態を確認する

他リポの変更が必要になった場合の手順:

1. **当該リポのファイルを編集しない**。「一旦編集して `git diff` を取る」は越境編集の
   実行そのもので、他リポの作業ツリーを dirty にするため diff 取得目的でも行わない
2. 変更内容は書き起こした unified diff として `.pecot/work/<Issue番号>/<slug>.patch` に退避する
3. 当該リポへの Issue 起票を提案する（起票するかはユーザーが判断する）

他リポへの dirty 残置・直接 commit はいずれも不可。持ち越す手段はパッチ退避だけ。

例外はユーザーの明示指示がある場合のみで、そのときは対象リポの WT へ移って作業する
（現 WT からは編集しない）。§5 の CLI ガードと同様、バイパスはユーザーの明示指示に限り、
AI 側で例外を作らない。
