# Data Model: 公開サイトのテストレポートを Allure Report に替える

側（Side）・保管の置き場所（StoreLayout）・出どころの確かめ（RunProvenance）は、028 の [data-model.md](../028-pages-site/data-model.md) のものを使う。ここには、この機能で足す・変えるものだけを書く。

## レポートのレーン（ReportLane）

`.githooks/scripts/test_report/report-lanes.json` の 1 項目。nx の `test-*` の target を全部並べる。

| 欄 | 例 | 決まり |
|---|---|---|
| `project` | `pecot-workflow` | nx の project の名前 |
| `target` | `test-hooks` | nx の target の名前。`test-` で始まる |
| `plugin` | `pecot-workflow` | 配布するプラグインのレーンなら、その名前。libs と `.githooks` のレーンは持たない |
| `results` | `plugins/pecot-workflow/test-results/test-hooks/allure-results` | レポートに入れるレーンだけが持つ。結果のディレクトリ。リポのルートからのパス |
| `excluded` | `node --test` | レポートに入れないレーンだけが持つ。入れない理由。今は持つレーンが無い |

決まり:

- `results` と `excluded` は、どちらか一方だけを持つ
- nx の `test-*` の target は、全部この一覧にある。無い target があると、`.githooks/tests/test_report_lanes.py` が落ちる
- `results` は、その target の nx の `outputs` にある
- `results` の最後のディレクトリの名前は `allure-results`
- 2026-11-26 に、レポートのレーンを nx の `test-*` のすべてに改めた（spec の FR-002）。`excluded` を持つレーンは、#809・#810 で無くなる

## テストの結果のラベルとリンク

Allure の結果（`<uuid>-result.json`）に、このリポが足すもの。vitest と pytest のほかの欄は、アダプタが付けるままにする。

| 種類 | 名前 | 値 | 付ける所 |
|---|---|---|---|
| ラベル | `project` | nx の project の名前 | vitest は reporter の `globalLabels`、pytest は `conftest.py`、bash は `allure-result.sh`（`bash-test.sh` と bats の formatter が呼ぶ） |
| ラベル | `lane` | nx の target の名前 | 同上 |
| ラベル | `epic` | nx の project の名前（#811） | vitest は reporter の `globalLabels`、pytest は `conftest.py`、bash は `allure-result.sh`（`bash-test.sh` と bats の formatter が呼ぶ） |
| ラベル | `feature` | 要件の ID を持つテストは、ID の属する定義書の項目の `name`（`<接頭辞>-COMMON-NN` は `<プラグイン> 共通`）。持たないテストは、ファイルのディレクトリ（リポのルートからのパス）（#811） | vitest は reporter の `listeners` の `beforeTestResultWrite`、pytest は `conftest.py`、bash は `allure-result.sh`（`bash-test.sh` と bats の formatter が呼ぶ） |
| ラベル | `story` | 要件の ID を持つテストは、その ID。持たないテストは、ファイル（リポのルートからのパス）（#811） | 同上 |
| ラベル | `layer` | `unit`・`integration`・`e2e`。テストのファイルの属する project の `test-layers.txt` で決める（#813） | vitest は reporter の `listeners` の `beforeTestResultWrite`、pytest は `conftest.py`、bash は `bash-test.sh` |
| ラベル | `severity` | テストに書いた段階。無ければ project・lane と要件の ID の有無から決めた段階（`.claude/rules/test-conventions.md` の「重大度」）（#812） | vitest は reporter の `listeners` の `beforeTestResultWrite`（`severityOf`）、pytest は `conftest.py`（minor）、bash は `bash-test.sh`（`bt_severity` か場所から決めた段階） |
| ラベル | `tag` | 要件の ID（`PW-…-01` など） | `verifies` |
| リンク（型 `tms`） | 名前は要件の ID | `<側の URL>permalink.html?id=<ID>` | `verifies` と、reporter の `links.tms.urlTemplate` |
| 添付 | テストが決める名前 | 判定に使った画面の画像か成果物 | 対象のテスト（research R11） |

- 1 つのテストが複数の ID を `verifies` で書いたら、tag とリンクを ID の数だけ持つ
  - `feature`・`story` は 1 組だけ持つ。COMMON でない ID のうち最初のもの、無ければ最初の COMMON の ID で決める。Allure の木は値の直積で作るので、全部持たせると実在しない組ができる
- `feature`・`story` の値は、グラフが epic をまたいで値だけで集めるので、project をまたいで重ならない形にする
- `layer` は、テストのピラミッドと層ごとの時間のグラフが集める。テストが自分で `layer` を付けたら、表の層を足さない
- 側の URL は、環境変数 `PECOT_REPORT_SITE_URL` で渡す。開発版は `https://pecotcraft.github.io/pecot/dev/`、リリース版は `https://pecotcraft.github.io/pecot/`。渡さなければ `http://localhost:8000/`
  - 開発版の材料になる PR の CI とマージキューの結果には、`ci.yml` の workflow の env が開発版の URL を渡す（#821）。この変数は nx の入力なので、両方の run に同じ値を渡して、マージキューが PR の run の nx キャッシュを取り込めるようにする
- bash のテストにはアダプタが無いので、`.githooks/scripts/test_report/allure-result.sh` が結果のファイルを書く
  - 呼ぶのは、`bt_*` の `bash-test.sh` と、bats の report formatter（`bats/allure-formatter.sh`）。bats 用の Allure の連携は、公式の物も第三者の物も無い（2026-11-27 に検索した）
  - 上の `project`・`lane` のほかに書く欄は次のとおり

| 欄 | `bt_*` の値 | bats の値 |
|---|---|---|
| `name` | 確かめの題 | `@test` の題 |
| `fullName` | `<project>:<target> <ファイルのパス>#<題>`。2 つのレーンで動くファイルが、1 件の再実行にまとまらないようにレーンを入れる | 同じ |
| `status` | `passed`・`failed`・`skipped`。ファイルが `bt_finish` の前で終わったら、題「最後まで動く」の `broken` | ok は `passed`、not ok は `failed`、skip は `skipped`。ファイルの単位の失敗（`setup_file` など）と timeout は `broken`。bats がファイルを読み込めなければ、題「読み込む」の `broken` |
| `statusDetails` | `message` に理由、`bt_eq`・`bt_ne` は `expected`・`actual` も。broken は `trace` に stderr の末尾 20 行 | `message` に bats-assert の見出しか失敗したコマンドの行、`trace` に not ok の後の行。bats-assert の比べた値は `expected`・`actual` に入れる |
| `description` | 無い | `explains` に渡した説明 |
| `start`・`stop` | 整数のミリ秒。`start` は前の確かめの終わり | 整数のミリ秒。`start` は `stop` から bats の `-T` の時間を引いた値 |
| ラベル `parentSuite` | リポのルートからのファイルのパス。vitest の結果と同じ段 | 同じ |
| ラベル `epic`・`feature`・`story` | `$NX_TASK_TARGET_PROJECT`・ファイルのディレクトリ・ファイル（どちらもリポのルートからのパス） | 同じ |
| ラベル `layer` | ファイルの属する project の `test-layers.txt` で引いた層。引けなければ書かない | 同じ |
| ラベル `severity` | ファイルで `bt_severity` を呼んだ後は、その段階。ほかは `$NX_TASK_TARGET_PROJECT`・`$NX_TASK_TARGET_TARGET` から決めた段階 | `@test` で `severity` を呼べば、その段階。ほかは同じ |
| ラベル `host`・`thread`・`language`・`framework` | `$HOSTNAME`・ファイルの PID・`bash`・`bash` | `$HOSTNAME`・formatter の PID・`bash`・`bats` |

## レポートの材料（ReportSources）

`test-report.yml` の `side` の job が決める値。

| 欄 | 開発版 | リリース版 |
|---|---|---|
| `side` | `dev` | `release` |
| `runs` | 結果がまだ無いレーンだけ。起動した run のコミットで流す（2026-11-26 に改めた。ほかのレーンは「レーンの最新の結果」を使う） | 結果を出せるタグを持つプラグインごとに 1 項目（そのタグのコミットで、そのプラグインのレーン）と、骨組みのコミットで、プラグインに属さないレーンの 1 項目 |
| `missing` | 空 | 結果を出せないタグのプラグインの名前 |
| `latest` | 拾ったレーン（下の LaneLatest）。レーンごとに、コミット・試した run・取り出す元の run と artifact | 持たない |

形（`report-sources.json`）。`generate.py` が読むのは `runs` と `latest` で、`commit` は 40 桁の 16 進、`lanes`・`lane` は `<project>:<target>`。

```json
{"side": "dev", "runs": [{"commit": "<SHA>", "lanes": ["pecot-workflow:test-cli"]}], "missing": [],
 "latest": [{"lane": "pecot-tools:test-cli", "commit": "<SHA>", "run_id": 123, "from_run": 456, "artifact": "allure-results-pecot-tools-test-cli"}]}
```

- 開発版の `runs` と `latest` のレーンは重ならず、合わせてレポートのレーンの全部になる。流すレーンが無ければ `runs` は空
- `run_id` はそのレーンを試した run で、レポートに出す。`from_run`・`artifact` は結果を取り出す元。前の開発版の run から持ち越すレーンは、`from_run` が前の run、`artifact` が `lane-latest`

決まり:

- タグが結果を出せるかは、そのタグのコミットに `report-lanes.json` があるかで決める
- リリース版の `runs` が空（どのプラグインも結果を出せない）なら、レポートを作らず、run は成功で終える
- 骨組みのコミットが結果を出せないときは、プラグインに属さないレーンを入れない
- 結果を出せるプラグインが無いときは、プラグインに属さないレーンも入れず、`runs` を空にする
- タグのコミットと骨組みの決め方は、028 の ReleaseSources と同じ（最新のタグ・プレリリースを除く・main の祖先）

## レーンの最新の結果（LaneLatest）

開発版のテストレポートの材料（2026-11-26 に足した。spec の FR-009a・FR-012）。

| 欄 | 値 |
|---|---|
| レーン | `<project>:<target>` |
| コミット | その結果が試した main のコミット。マージキューと PR の CI の結果は、そのマージキューのコミット（main に入ったコミット）。main で流した結果は、流したコミット |
| run | そのレーンを試した run。PR の CI の結果は、PR の run |
| 結果 | そのレーンの結果のディレクトリ（`allure-results`）の中身 |

決まり:

- 持つのは、次の run の結果だけ。マージされなかった run の結果は持たない
  - main に入ったコミットを試したマージキューの run
  - そのマージキューの run が、積のモードで省いたレーンの分として指した PR の CI の run（2026-11-27 に足した）
  - main で結果の無いレーンを流した、開発版の run
- レーンごとに 1 回分だけを持ち、同じレーンの新しい結果で置き換える
- マージの変更が届かないレーンは、前の結果のまま残す
- 変更が届いたレーンは、マージキューが積のモードで省いたもの（PR の CI で試し済みのもの）も含め、その変更を試した run の結果に置き換える
- 一番新しい変更を試した結果が無いレーンには、それより古い結果を使わず、main で流す
- マージキューを通らずに main に入るコミット（リリースの land など）で入力が変わったレーンは、main で流した結果に置き換える。キューを通ったかは、そのコミットを head とするマージキューの run の有無で見分ける

置き場所（2026-11-27 に #821 で決めた）:

| artifact | 上げる run | 中身 | 保持 |
|---|---|---|---|
| `allure-results-<slug>` | `ci.yml` の tests（同じリポの PR とマージキュー。成功した job だけ） | レーンの結果のディレクトリ | 30 日 |
| `lane-sources` | `ci.yml` の lanes（マージキューだけ） | `{"commit", "pr", "pr_head", "pr_run", "merge_group": [レーン], "pull_request": [レーン]}`。そのコミットで変更が届いたレーンと、結果を持つ run | 30 日 |
| `lane-latest` | `test-report.yml` の report（開発版だけ） | 全レーンの結果のディレクトリと `source.json` | 90 日 |
| `lane-latest-index` | 同上 | `{"commit", "lanes": {"<レーン>": {"commit", "run_id"}}}` | 90 日 |

- 開発版の run（`dev_sources.py`）は、前の開発版の run の `lane-latest-index` から始め、今のコミットから first-parent で遡ってレーンを決める
- 読む run は、GitHub の API で確かめる
  - 前の開発版の run: `test-report.yml` の `push` か `workflow_dispatch` の成功した run で、head が今のコミットの祖先
  - マージキューの run: `ci.yml` の `merge_group` の run で、head がそのコミットで、`ci-result` の job が成功
  - PR の run: `ci.yml` の `pull_request` の run で、head が `lane-sources` の `pr_head`
    - あわせて、PR を `pulls/<番号>` で読み、base と head がこのリポで、head の SHA が `pr_head`、head のブランチが run の `head_branch` であることを確かめる
    - マージ後の run の `pull_requests` は空になるので使わない
- 前の run が無いか、50 コミット遡っても届かないとき（初めての run・artifact が消えた後）は、決まらなかったレーンを main で流す

## そろいの判定（ResultsCheck）

`generate.py` が、レポートを作る前に行う。

| 確かめ | 落ちる条件 |
|---|---|
| 結果のディレクトリ | ReportSources の `runs` にあるレーン（開発版は、`latest` も含めた全レーン）のうち、`results` のディレクトリが無いか、`*-result.json` が 1 つも無いレーンがある |
| そろい（開発版） | `runs` と `latest` を合わせて、レポートのレーンの全部が無いか、同じレーンが 2 回ある |
| コミット（リリース版） | 手元でない実行で、結果の artifact の `source.json`（`tests` の job が書く、レーンと取り出したコミット）が無いか、`runs` のコミットと違う |
| コミット（開発版） | `source.json` が `runs`・`latest` のコミットと違うか、そのコミットが今のコミット（`HEAD`）の祖先でない（`git merge-base --is-ancestor`）。`latest` のレーンの `source.json` は、report の job が取り出すときに書く（2026-11-27 に #821 で決めた） |

- 落ちたら、欠けたレーンの名前を出して失敗する。レポートは作らない（FR-012・FR-015）
- 手元では、ある結果だけで作る。欠けたレーンを出して続ける（FR-024）
- 手元でない実行は、ReportSources（`--sources`）を必ず受ける。受けないと、コミットを確かめられない
- `source.json` は、結果のディレクトリの親（`<project>/test-results/<target>/source.json`）に置く。形は `{"lane": "<project>:<target>", "commit": "<SHA>"}`
  - 結果のディレクトリの中に置かないのは、Allure がそのディレクトリのファイルを全部、読み手に渡すため

## レーンの結果のコミット（ReportVariables）

各レーンの結果がどのコミットのものかを、レポートの先頭の変数（Allure の `variables`）で出す（2026-11-27 に #821 で足した。spec の FR-012）。

| 欄 | 値 |
|---|---|
| 名前 | レーン（`<project>:<target>`） |
| 値 | `<40 桁の SHA> <試した run の URL>`。run の URL は `<GITHUB_SERVER_URL>/<GITHUB_REPOSITORY>/actions/runs/<ID>`。`runs` のレーンは、レポートを作る run |

- `generate.py` が、手元でない実行で、環境変数 `PECOT_REPORT_VARIABLES`（JSON のオブジェクト）に入れて渡し、`allurerc.mjs` が `variables` にする。手元では渡さない
- リポか run の ID が分からなければ、値は SHA だけにする

## 履歴（History）

リリース版だけが持つ。開発版は履歴を持たず、`generate.py` に `--history` を渡さない（2026-11-26 に改めた。spec の FR-018〜FR-020）。

| 欄 | 値 |
|---|---|
| 側 | リリース版だけ |
| 置き場所 | S3 のバケット `pecot-test-report-history-<アカウント ID>`（ap-southeast-2）の `release/history.jsonl`。`pages-store` には置かない（#822） |
| 形 | Allure 3 の履歴の JSONL。1 回の実行が 1 行 |
| 上限 | 10 行（`historyLimit`。大きさの理由は research R5） |
| 読む人 | `test-report.yml` の `history-get` の job |
| 足す人 | `report` の job。`generate.py` が、読んだファイルに 1 行足す |
| 書く人 | `history-put` の job。S3 に条件付きの書き込みで戻す（#822） |

状態の移り変わり（`history-get` の `state`）:

- `absent`（初めて）: ファイルが無い。空の履歴でレポートを作り、`If-None-Match: *` で 1 行のファイルを置く
- `found`（2 回目から）: S3 のファイルを読み、1 行足し、取ったときの ETag を `If-Match` に付けて戻す。10 行を超えたら、古い行から消える
- `unreadable`（入れない・S3 の失敗・読めない行）: 空の履歴として作る（FR-021）。知らせを job summary に書き、S3 には書き戻さない
- 書き戻しが条件で断られた: S3 の履歴が、読んだ後に変わった。書かずに run を失敗にする

決まり:

- 読めない行は、Allure（Node の readline と `JSON.parse`）が読めない行とする。`history-get` は `generate.py` の `read_history` でこの決まりを確かめる
  - UTF-8 でないファイルは、全体を読めないとする
  - 行の区切りは `\r\n`・`\n`・`\r`・U+2028・U+2029（Node の readline）。`JSON.stringify` は U+2028 をエスケープしないので、文字列に U+2028 を含む行は 2 つに切れて読めない
    - Allure は自分で書いた行を次の回に読めない（テストの名前に U+2028 を含むと起きる）。`generate.py` は、Allure が書いた後で U+2028・U+2029 を `\u2028`・`\u2029` にエスケープする。値は変わらない（#698）
  - JS の `trim()` で空になる行は飛ばす。空白とするのは ECMAScript の WhiteSpace と LineTerminator で、Python の `str.strip()` とは違う（U+FEFF を含み、`\x1c`〜`\x1f`・U+0085 を含まない）
  - `null` の行は、`JSON.parse` は通るが、Allure がその後で落ちる
  - `NaN`・`Infinity` を含む行と、オブジェクトでない行（`null` など）は読めない
- 履歴のファイルは、レポートの出力のディレクトリの外に置いて渡す。`allure generate --clean` は、入力のファイルを含む出力を消せない。レポートと一緒に置くときは、作った後に写す
- `generate.py` は、`--history` のときだけ環境変数 `PECOT_REPORT_HISTORY` で `allurerc.mjs` の `historyPath` に渡す。Allure 3.33.0 の CLI に、履歴のパスの引数が無いため
  - `historyPath` を書かなければ、Allure は履歴を読み書きしない。`resolveConfig` に既定のパスが無い
    - 出典はソース（`@allurereport/core/dist/config.js` の `historyPath: historyPath ? resolve(historyPath) : undefined`）
    - `test_report_generate.py` が、`readConfig` で解いた値で確かめる
- Allure がレポートの名前の後ろに足すのは、PR の run の「– Pull request #N」だけ。履歴の行の `name` も同じになる
  - 出典はソース（3.33.0 の `@allurereport/core/dist/report.js` の `reportTitleSuffix`）
  - `pullRequestName ?? jobRunName` で、PR でない run の `pullRequestName` は空文字なので、job の名前は足さない
  - `test-report.yml` は PR で動かないので、名前は `allurerc.mjs` の「pecot テストレポート」のまま

## 保管の置き場所（StoreLayout に足すもの）

| 置き場所 | 中身 | 差し替えるとき |
|---|---|---|
| `/test-report/` | リリース版のレポート。履歴は S3 にあり、ここには置かない | リリース版のレポートを受けたとき。定義書のリリース版を差し替えるときは残す |
| `/dev/test-report/` | 開発版のレポート。履歴は持たない | 開発版のレポートを受けたとき。定義書の開発版を差し替えるときは残す |
| `.pecot-store.json` の `reports` | 側ごとの、レポートを作った run の ID とコミット。リリース版は材料（`sources`）も書く | レポートを受けたとき |

- レポートがまだ無い側の `test-report/index.html` には、案内のページを置く。リリース版で、結果を出せるプラグインが無い間も同じ
- `pr/<番号>/` には `test-report/` を置かない
- 開発版のレポートは、保管中のレポートより古いコミットのものなら捨てる
- レポートの tar に `history.jsonl` があれば、SideCheck が捨てる（開発版は 2026-11-27 に #821 で、リリース版は #822 で足した）。`test-report/` は丸ごと差し替えるので、前に保管した `history.jsonl` は次の保管で消える

## サイトのリンク（SiteStamp に足すもの）

| 欄 | 出どころ | 値 |
|---|---|---|
| `report_url` | `PECOT_SITE_SIDE` | 開発版と、`report_plugins` が空でないリリース版は `test-report/index.html`（その側のルートからの相対）。PR 版・手元は無し |
| `report_plugins` | `PECOT_SITE_REPORT_PLUGINS`（リリース版だけ。`release_build.py` が渡す） | レポートに入っているプラグインの名前の一覧。開発版は全部のプラグイン |
| `report_missing` | サイトに載せるプラグインと `report_plugins` | リリース版で、`report_plugins` に無いプラグインの名前。ほかの側は空 |

決まり:

- 側からのリンクは、`report_url` があり、`report_plugins` が空でないときに出す
- 項目からのリンク（`test-report/index.html?tags=<ID>`）は、その項目のプラグインが `report_plugins` にあるときに出す
- リリース版で、`report_plugins` に無いプラグインがあれば、その名前を側からのリンクのそばに書く
