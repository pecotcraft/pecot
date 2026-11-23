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
| `excluded` | `bash の *.test.sh` | レポートに入れないレーンだけが持つ。入れない理由 |

決まり:

- `results` と `excluded` は、どちらか一方だけを持つ
- nx の `test-*` の target は、全部この一覧にある。無い target があると、`.githooks/tests/test_report_lanes.py` が落ちる
- `results` は、その target の nx の `outputs` にある
- `results` の最後のディレクトリの名前は `allure-results`

## テストの結果のラベルとリンク

Allure の結果（`<uuid>-result.json`）に、このリポが足すもの。ほかの欄は、アダプタが付けるままにする。

| 種類 | 名前 | 値 | 付ける所 |
|---|---|---|---|
| ラベル | `project` | nx の project の名前 | vitest は reporter の `globalLabels`、pytest は `conftest.py` |
| ラベル | `lane` | nx の target の名前 | 同上 |
| ラベル | `tag` | 要件の ID（`PW-…-01` など） | `verifies` |
| リンク（型 `tms`） | 名前は要件の ID | `<側の URL>permalink.html?id=<ID>` | `verifies` と、reporter の `links.tms.urlTemplate` |
| 添付 | テストが決める名前 | 判定に使った画面の画像か成果物 | 対象のテスト（research R11） |

- 1 つのテストが複数の ID を `verifies` で書いたら、tag とリンクを ID の数だけ持つ
- 側の URL は、環境変数 `PECOT_REPORT_SITE_URL` で渡す。開発版は `https://pecotcraft.github.io/pecot/dev/`、リリース版は `https://pecotcraft.github.io/pecot/`。渡さなければ `http://localhost:8000/`

## レポートの材料（ReportSources）

`test-report.yml` の `side` の job が決める値。

| 欄 | 開発版 | リリース版 |
|---|---|---|
| `side` | `dev` | `release` |
| `runs` | 1 項目。起動した run のコミットで、全レーン | 結果を出せるタグを持つプラグインごとに 1 項目（そのタグのコミットで、そのプラグインのレーン）と、骨組みのコミットで、プラグインに属さないレーンの 1 項目 |
| `missing` | 空 | 結果を出せないタグのプラグインの名前 |

決まり:

- タグが結果を出せるかは、そのタグのコミットに `report-lanes.json` があるかで決める
- リリース版の `runs` が空（どのプラグインも結果を出せない）なら、レポートを作らず、run は成功で終える
- 骨組みのコミットが結果を出せないときは、プラグインに属さないレーンを入れない
- タグのコミットと骨組みの決め方は、028 の ReleaseSources と同じ（最新のタグ・プレリリースを除く・main の祖先）

## そろいの判定（ResultsCheck）

`generate.py` が、レポートを作る前に行う。

| 確かめ | 落ちる条件 |
|---|---|
| 結果のディレクトリ | ReportSources の `runs` にあるレーンのうち、`results` のディレクトリが無いか、`*-result.json` が 1 つも無いレーンがある |
| コミット | 手元でない実行で、結果の artifact の `source.json`（`tests` の job が書く、レーンと取り出したコミット）が無いか、`runs` のコミットと違う |

- 落ちたら、欠けたレーンの名前を出して失敗する。レポートは作らない（FR-012・FR-015）
- 手元では、ある結果だけで作る。欠けたレーンを出して続ける（FR-024）

## 履歴（History）

| 欄 | 値 |
|---|---|
| 置き場所 | `pages-store` の `<側>/test-report/history.jsonl` |
| 形 | Allure 3 の履歴の JSONL。1 回の実行が 1 行 |
| 上限 | 20 行（`historyLimit`） |
| 書く人 | `test-report.yml` の `report` の job が、読んだファイルに 1 行足して artifact に入れ、`pages-deploy.yml` の store が置く |

状態の移り変わり:

- 初めて: ファイルが無い。空の履歴でレポートを作り、1 行のファイルができる
- 2 回目から: 公開中のファイルを読み、1 行足す。20 行を超えたら、古い行から消える
- 読めない（壊れている・取れない）: 空の履歴として作る（FR-021）。知らせを job summary に書く

## 保管の置き場所（StoreLayout に足すもの）

| 置き場所 | 中身 | 差し替えるとき |
|---|---|---|
| `/test-report/` | リリース版のレポートと履歴 | リリース版のレポートを受けたとき。定義書のリリース版を差し替えるときは残す |
| `/dev/test-report/` | 開発版のレポートと履歴 | 開発版のレポートを受けたとき。定義書の開発版を差し替えるときは残す |
| `.pecot-store.json` の `reports` | 側ごとの、レポートを作った run の ID とコミット | レポートを受けたとき |

- レポートがまだ無い側の `test-report/index.html` には、案内のページを置く。リリース版で、結果を出せるプラグインが無い間も同じ
- `pr/<番号>/` には `test-report/` を置かない
- 開発版のレポートは、保管中のレポートより古いコミットのものなら捨てる

## サイトのリンク（SiteStamp に足すもの）

| 欄 | 出どころ | 値 |
|---|---|---|
| `report_url` | `PECOT_SITE_SIDE` | 開発版・リリース版は `test-report/`（その側のルートからの相対）。PR 版・手元は無し |
| `report_plugins` | `PECOT_SITE_REPORT_PLUGINS`（リリース版だけ。`release_build.py` が渡す） | レポートに入っているプラグインの名前の一覧。開発版は全部のプラグイン |

決まり:

- 側からのリンクは、`report_url` があり、`report_plugins` が空でないときに出す
- 項目からのリンク（`<report_url>index.html?tags=<ID>`）は、その項目のプラグインが `report_plugins` にあるときに出す
- リリース版で、`report_plugins` に無いプラグインがあれば、その名前を側からのリンクのそばに書く
