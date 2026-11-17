# Data Model: pecot の文書サイトを GitHub Pages で公開する

## 側（Side）

公開サイトを作る単位。1 つの側は 1 つのコミットから作る。

| 欄 | 値 | 決まり |
|---|---|---|
| `kind` | `release` / `dev` / `pr` / `local` | `local` は手元で作ったときだけ。公開の流れには出ない。spec の「側」は公開サイトの 3 種で、`local` は帯の表示のためだけの値 |
| `pr` | PR の番号 | `kind` が `pr` のときだけ持つ |
| `path` | 公開サイトの中の置き場所 | `release` は `/`、`dev` は `/dev/`、`pr` は `/pr/<番号>/` |

状態の移り変わり:

- `release`: リリースのたびに中身を差し替える。消えない
- `dev`: main への push のたびに中身を差し替える。消えない
- `pr`: 同じリポの PR が開いたときに現れる。head への push で中身を差し替え、PR が閉じたら消える

## 公開の版（SiteStamp）

各側の、すべてのページの上の帯に出す情報。サイトを作るときに 1 つ決める。

| 欄 | 出どころ | 手元で作るとき |
|---|---|---|
| `side` | `PECOT_SITE_SIDE` | `local` |
| `pr` | `PECOT_SITE_PR` | 無し |
| `sha` | `PECOT_SITE_SHA`（帯には先頭 7 文字） | `git rev-parse HEAD` |
| `plugins` | 各プラグインの `package.json` の `version` | 同じ |
| `built_at` | `PECOT_SITE_BUILT_AT`（合否を作った run の開始時刻、UTC） | 今の時刻 |
| `run_url` | `PECOT_SITE_RUN_URL`（作る run の URL） | 無し（帯にリンクを出さない） |

決まり:

- `sha` が取れないときは、サイトを作らずに失敗する
- `side` が `pr` なら `pr` は必須。帯に PR の番号と PR へのリンクを出す
- 帯は、リリース版と開発版を行き来するリンクを持つ。PR 版の帯にも、この 2 つへのリンクを置く。PR 版どうしのリンクは置かない（FR-025）

## 合否のレーン（JunitLane）

`libs/interface-spec/docs/junit-lanes.json` の 1 項目。

| 欄 | 例 | 決まり |
|---|---|---|
| `plugin` | `pecot-workflow` | 定義書を持つプラグインの名前。`target` の `<project>` と同じ |
| `target` | `pecot-workflow:test-hooks` | nx の `<project>:<target>` |
| `junit` | `plugins/pecot-workflow/cli/test-results/junit-hooks.xml` | リポのルートからのパス。1 つのレーンに 1 つ |

決まり:

- 同じ `junit` を 2 回書かない（今の `iface_junit` の重なりを解く）
- 同じ `target` を 2 回書かない（matrix の job の名前と artifact の名前が重なる）
- `target` の `outputs` に `junit` が入っていなければならない（`interface-spec:test-unit` で確かめる）

## 振る舞いの状態（Outcome）

振る舞いの項目 1 つの状態。つながるテストのケースの結果から決める。

| 状態 | 表示 | 記号 | 条件（上から順に当てる） |
|---|---|---|---|
| `not-run` | 未実行 | `?` | そのプラグインの合否のレーンのうち、JUnit が無いものがある |
| `no-test` | テストが無い | `–` | JUnit はそろっているが、項目につながるケースが 0 件 |
| `failed` | 落ちた | `✗` | つながるケースに failed か error が 1 つでもある |
| `passed` | 通った | `✓` | つながるケースに passed が 1 つ以上あり、ほかは passed か skipped |
| `skipped` | 飛ばした | `−` | つながるケースがすべて skipped |

決まり:

- 公開の流れで作るサイトでは、`not-run` は現れない（JUnit が欠けたら作る run が失敗するため）
- `passed` で、一部のケースが skipped のときは、項目のページで飛ばしたケースを示す
- 表示は記号と文字の両方を出す。色は補いにだけ使う（FR-015）

## 落ちたケースの要旨（FailureNote）

`failed` の項目のページに出す、落ちたケースごとの情報。

| 欄 | 出どころ |
|---|---|
| `case` | JUnit の `classname` と `name` |
| `message` | JUnit の `<failure>`・`<error>` の `message` 属性。無ければ本文の先頭の 1 行 |
| `detail` | 本文（スタックを含む）。折りたたんで出す |

## 状態の数（OutcomeCount）

| 置き場所 | 単位 |
|---|---|
| プラグインの一覧表 | コマンド・ツールの行ごと |
| トップの全体の合否 | プラグインごと |

5 つの状態ごとの件数。0 件の状態は出さない。

## 組み立ての入力（DeployPlan）

公開する run が、組み立ての前に決める一覧。

| 欄 | 決め方 |
|---|---|
| `release` | `pages-build.yml` の成功した run のうち、`side=release` で run の作成時刻が最も新しいもの。その artifact `pages-side-release` |
| `dev` | 同じく `side=dev` で run の作成時刻が最も新しいもの |
| `prs` | 今開いている、同じリポのブランチの PR。それぞれについて、`side=pr` かつその PR の番号の最新の成功した run |

決まり:

- `release` の artifact が無いときは公開しない（research R4）
- `dev` の artifact が無いときは、`/dev/` を置かずに公開し、run の summary に書く（初回の公開に当たる）
- PR の artifact が無い PR（作る run がまだ終わっていない・落ちた）は、その PR の側を置かない
- 展開した中身が、自分の `path` の外を指すもの（絶対パス・`..`・シンボリックリンク）を含むときは、その側を外して run の summary に書く
- 組み立てたツリーの大きさが 900 MB を超えたら、run の summary に警告を書く（上限は 1 GB）
