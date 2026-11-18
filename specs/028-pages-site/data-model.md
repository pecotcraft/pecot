# Data Model: pecot の文書サイトを GitHub Pages で公開する

## 側（Side）

公開サイトを作る単位。開発版と PR 版は 1 つのコミットから作る。リリース版は、プラグインごとのタグのコミットから作る（ReleaseSources）。

| 欄 | 値 | 決まり |
|---|---|---|
| `kind` | `release` / `dev` / `pr` / `local` | `local` は手元で作ったときだけ。公開の流れには出ない。spec の「側」は公開サイトの 3 種で、`local` は版の知らせのためだけの値 |
| `pr` | PR の番号 | `kind` が `pr` のときだけ持つ |
| `path` | 公開サイトと `pages-store` の中の置き場所 | `release` は `/`、`dev` は `/dev/`、`pr` は `/pr/<番号>/` |

状態の移り変わり:

- `release`: リリースのたびに中身を差し替える。消えない
- `dev`: main への push のたびに中身を差し替える。消えない
- `pr`: 同じリポの PR が開いたときに現れる。head への push で中身を差し替え、PR が閉じた後の保管で消える

## 版の知らせ（SiteStamp）

リリース版でない側の、ページの上の知らせを決める値。出し方は contracts/pages.md の「版の知らせ」。

| 欄 | 出どころ | 手元で作るとき |
|---|---|---|
| `side` | `PECOT_SITE_SIDE` | `local` |
| `pr` | `PECOT_SITE_PR` | 無し |

決まり:

- `side` が `pr` なら `pr` は必須。上の知らせに PR の番号と PR へのリンクを出す
- 開発版と PR 版の知らせは、最新のリリース版（`/pecot/`）へのリンクを持つ。PR 版どうしのリンクは置かない（FR-025）

## 合否のレーン（JunitLane）

`libs/interface-spec/docs/junit-lanes.json` の 1 項目。

| 欄 | 例 | 決まり |
|---|---|---|
| `plugin` | `pecot-workflow` | 定義書を持つプラグインの名前。`target` の `<project>` と同じ |
| `target` | `pecot-workflow:test-hooks` | nx の `<project>:<target>` |
| `junit` | `plugins/pecot-workflow/cli/test-results/junit-hooks.xml` | リポのルートからのパス。1 つのレーンに 1 つ |

決まり:

- 同じ `junit` を 2 回書かない（今の `iface_junit` の重なりを解く）
- 同じ `target` を 2 回書かない（同じレーンを 2 回動かし、JUnit の置き場所が重なる）
- `target` の `outputs` に `junit` が入っていなければならない（`interface-spec:test-unit` で確かめる）

## 振る舞いの状態（Outcome）

振る舞いの項目 1 つの状態。つながるテストのケースの結果から決める。

| 状態 | 表示 | 記号 | 条件（上から順に当てる） |
|---|---|---|---|
| `not-run` | 未実行 | `?` | そのプラグインの合否のレーンのうち、JUnit が無いものがある |
| `no-test` | テストなし | `–` | JUnit はそろっているが、項目につながるケースが 0 件 |
| `failed` | 失敗 | `✗` | つながるケースに failed か error が 1 つでもある |
| `passed` | 成功 | `✓` | つながるケースに passed が 1 つ以上あり、ほかは passed か skipped |
| `skipped` | スキップ | `−` | つながるケースがすべて skipped |

決まり:

- 公開の流れで作るサイトは、状態を出さない（2026-11-18、#648）。状態が出るのは、手元で `PECOT_SITE_RESULTS=1` を付けて作ったときだけ
- `passed` で、一部のケースが skipped のときは、項目のページでスキップしたテストを示す
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

## リリース版の材料（ReleaseSources）

リリース版を作る run が、作る前に決める一覧。research R13。

| 欄 | 決め方 |
|---|---|
| `tags` | プラグインごとの最新のタグ。`<plugin>-v<semver>` のうち、プレリリースの接尾辞が無いものの semver の最大値。プラグインは main の `plugins/*/.claude-plugin/plugin.json` から決める |
| `commits` | 各タグが指すコミット |
| `skeleton` | `commits` のうち、ほかのすべてを祖先に持つもの。骨組み（`libs/interface-spec`）と骨組みの文書をここから取る |
| `lanes` | 各プラグインのタグのコミットの `junit-lanes.json` のうち、そのプラグインのレーン |

決まり:

- `commits` のどれかが main の祖先でないときは作らない
- `skeleton` が決まらない（ほかのすべてを祖先に持つコミットが無い）ときは作らない
- 各プラグインの `plugins/<name>/` は、そのタグの中身に差し替えてからサイトを作る
- 作った側の artifact に、`release-sources.json`（`tags`・`commits`・`skeleton`）を入れる。保管して公開する run は、これを API から求め直した値と比べる

## 受け取った run の確かめ（RunProvenance）

保管して公開する run が、`workflow_run` で受けた run を `GET /repos/{owner}/{repo}/actions/runs/{run_id}` で読み直して確かめる項目。research R3。

側は 2 段で決める。

1. API の項目で、信頼の境界を決める。PR 版の run か、main の祖先のコミットの定義で動いた run かを分ける。artifact の名前や中身は使わない
2. main の祖先の定義で動いた `workflow_dispatch` の run に限り、`dev` か `release` かを、その run が上げた側の artifact の名前（`pages-side-dev`・`pages-side-release`）で決める。2 つとも有るか、どちらも無いときは捨てる
   - run の API には、起動の入力（`side`）が無い。そのため、API の項目だけでは 2 つを分けられない
   - その定義は main に入ったレビュー済みのものなので、名前を信じてよい
   - `push` の run は開発版、`pull_request` の run は PR 版に決まり、名前は使わない
   - PR 版では、1 で決めた PR の番号から作った `pages-side-pr-<番号>` が、その run の artifact に無ければ捨てる。fork の PR の run（側を作らない run）を、ここで落とす

| 側 | `path` | `event` | `conclusion` | `head_repository` | `head_sha` | PR |
|---|---|---|---|---|---|---|
| 開発版 | `.github/workflows/pages-build.yml` | `push` か `workflow_dispatch` | `success` | このリポ | main の祖先。保管中の開発版の SHA を祖先に持つ | 見ない |
| リリース版 | 同上 | `workflow_dispatch` | `success` | このリポ | main の祖先。API から求め直した ReleaseSources が、artifact の `release-sources.json` と一致する | 見ない |
| PR 版 | 同上 | `pull_request` | `success` | このリポ | その PR の今の head と一致する | 下の決まり |

決まり:

- どの側も、pages-build.yml の run からだけ受ける。ci.yml の run は受けない（2026-11-18、#648 で改めた。ci の run を待つと、PR 版がテストの終わりまで出ないため）
- PR の作者は自分のブランチの pages-build.yml を書き換えられる。そのため、`pull_request` の run は PR 版にしか使わず、開発版・リリース版は main の祖先のコミットの run からだけ受ける
- main の祖先かは、`GET /repos/{owner}/{repo}/compare/{head_sha}...main` の `behind_by == 0` で決める
- `head_branch` では、ブランチを判定しない。タグで動いた run では、`head_branch` にタグ名が入るため
- 開発版で、保管中の開発版と同じ SHA の run（再実行）は受ける。保管中の SHA を祖先に持たない run（古い run）は捨てる
- 開発版・リリース版では `pull_requests` を見ない。ほかのリポの PR（fork が上流の main から開いた PR）も入るため
- PR 版は、`pull_requests` を、`base.repo.full_name` がこのリポで `head.sha == run.head_sha` のものに絞る。そのうえで `GET /repos/{owner}/{repo}/pulls/{n}` で `state=open` と `head.sha` を確かめる。1 件に絞れないときは捨てる
- `event` が `pull_request` で、PR が閉じている run（closed の契機）は、側を作らない。保管の job の、閉じた PR の掃除だけを起こす
- artifact は、確かめた run の ID と、確かめた側から作った名前（`pages-side-dev`・`pages-side-release`・`pages-side-pr-<番号>`）で取る
- 合わない run は、理由を run の summary に書いて捨てる。その run の公開は失敗にしない

## 受けた側の中身の確かめ（SideCheck）

verify の job が、artifact を展開したツリーに対して確かめること。中身は実行しない。

- 絶対パス・`..`・シンボリックリンク・通常のファイルとディレクトリ以外のものを含むときは、その側を捨てて run の summary に書く
- 側の中の内部リンクが切れていたら捨てる
- 側の間の行き来のリンク（`/pecot/`・`/pecot/dev/`）は、verify では確かめない。先は store が置く側か案内のページなので、store が組んだ `pages-store` の全体で確かめる

## 保管ブランチの形（StoreLayout）

`pages-store` の中身。公開する run は、この全体を公開する。

| パス | 中身 |
|---|---|
| `/` | リリース版。まだ無いときは案内のページ |
| `/dev/` | 開発版。まだ無いときは案内のページ |
| `/pr/<番号>/` | 開いている PR の PR 版 |
| `/.pecot-store.json` | 側ごとのコミット（リリース版は ReleaseSources）・作った run の ID・保管した時刻 |

決まり:

- 書き換えるのは、受けた側のディレクトリと `.pecot-store.json` だけ。リリース版の `/` を書き換えるときは、`/dev/` と `/pr/` を残す
- 保管のたびに、閉じた PR の側を消す。開いている PR の番号の一覧は、verify（`pull-requests: read` を持つ）が API から求めて出力にする。store は、その一覧に無い `pr/<番号>/` を消す。store は API を読まない
- 案内のページは、ある方の側へのリンクを持つ
- 開発版を書き換える前に、取った `.pecot-store.json` の開発版の SHA が、受けた SHA の祖先（同じを含む）かを git で確かめ直す。違えば書き換えない。verify と store の間に、新しい開発版が先に保管されることがあるため
- `.pecot-store.json` は公開されない。`upload-pages-artifact` が `.` で始まるファイルを除くため
- 書き換えが無ければ push しない
- コミットは毎回 1 つの orphan のコミットにして、`--force-with-lease=<取ったときの SHA>` で push する。断られたら取り直してやり直す
- 全体の大きさが 900 MB を超えたら、run の summary に警告を書く（上限は 1 GB）
