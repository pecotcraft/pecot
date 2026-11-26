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
- 2026-11-26 に、レポートのレーンを nx の `test-*` のすべてに改めた（spec の FR-002）。`excluded` を持つレーンは、#809・#810 で無くなる

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
  - 開発版の材料になるマージキューの結果に、開発版の URL を渡す形は #821 で決める。この変数は nx の入力で、マージキューは PR の run の nx キャッシュを取り込むため

## レポートの材料（ReportSources）

`test-report.yml` の `side` の job が決める値。

| 欄 | 開発版 | リリース版 |
|---|---|---|
| `side` | `dev` | `release` |
| `runs` | 結果がまだ無いレーンだけ。起動した run のコミットで流す（2026-11-26 に改めた。ほかのレーンは「レーンの最新の結果」を使う） | 結果を出せるタグを持つプラグインごとに 1 項目（そのタグのコミットで、そのプラグインのレーン）と、骨組みのコミットで、プラグインに属さないレーンの 1 項目 |
| `missing` | 空 | 結果を出せないタグのプラグインの名前 |

形（`report-sources.json`）。`generate.py` が読むのは `runs` だけで、`commit` は 40 桁の 16 進、`lanes` は `<project>:<target>`。

```json
{"side": "dev", "runs": [{"commit": "<SHA>", "lanes": ["pecot-workflow:test-cli"]}], "missing": []}
```

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
| コミット | その結果を流したコミット。main に入ったコミット |
| 結果 | そのレーンの結果のディレクトリ（`allure-results`）の中身 |

決まり:

- 持つのは、main に入ったコミットを試したマージキューの run と、main で結果の無いレーンを流した run の結果だけ。マージされなかった run の結果は持たない
- レーンごとに 1 回分だけを持ち、同じレーンの新しい結果で置き換える
- マージの変更が届かないレーンは、前の結果のまま残す
- 変更が届いたレーンは、マージキューが積のモードで省いたもの（PR の CI で試し済みのもの）も含め、その変更を試した run の結果に置き換える
- マージキューを通らずに main に入るコミット（リリースの land など）で入力が変わったレーンは、main で流した結果に置き換える
- 置き場所・書く run・コミットの確かめ方・積のモードで省いたレーンの結果の取り方・キューを通らないコミットの見分け方は #821 で決める

## そろいの判定（ResultsCheck）

`generate.py` が、レポートを作る前に行う。

| 確かめ | 落ちる条件 |
|---|---|
| 結果のディレクトリ | ReportSources の `runs` にあるレーン（開発版は、レーンの最新の結果も含めた全レーン）のうち、`results` のディレクトリが無いか、`*-result.json` が 1 つも無いレーンがある |
| コミット（リリース版） | 手元でない実行で、結果の artifact の `source.json`（`tests` の job が書く、レーンと取り出したコミット）が無いか、`runs` のコミットと違う |
| コミット（開発版） | レーンごとのコミットが分からないか、main の祖先でない。確かめ方は #821 で決める（2026-11-26 に改めた） |

- 落ちたら、欠けたレーンの名前を出して失敗する。レポートは作らない（FR-012・FR-015）
- 手元では、ある結果だけで作る。欠けたレーンを出して続ける（FR-024）
- 手元でない実行は、ReportSources（`--sources`）を必ず受ける。受けないと、コミットを確かめられない
- `source.json` は、結果のディレクトリの親（`<project>/test-results/<target>/source.json`）に置く。形は `{"lane": "<project>:<target>", "commit": "<SHA>"}`
  - 結果のディレクトリの中に置かないのは、Allure がそのディレクトリのファイルを全部、読み手に渡すため

## 履歴（History）

リリース版だけが持つ。開発版は履歴を持たず、`generate.py` に `--history` を渡さない（2026-11-26 に改めた。spec の FR-018〜FR-020）。

| 欄 | 値 |
|---|---|
| 側 | リリース版だけ |
| 置き場所 | S3 のバケットの 1 つのファイル `history.jsonl`。`pages-store` には置かない。バケットの名前は #822 で決める |
| 形 | Allure 3 の履歴の JSONL。1 回の実行が 1 行 |
| 上限 | 10 行（`historyLimit`。大きさの理由は research R5） |
| 書く人 | `test-report.yml` の `report` の job が、読んだファイルに 1 行足す。S3 に書く run とロールは #822 で決める |

状態の移り変わり:

- 初めて: ファイルが無い。空の履歴でレポートを作り、1 行のファイルができる
- 2 回目から: S3 に保管中のファイルを読み、1 行足す。10 行を超えたら、古い行から消える
- 読めない（壊れている・取れない）: 空の履歴として作る（FR-021）。知らせを job summary に書く

決まり:

- 読めない行は、Allure（Node の readline と `JSON.parse`）が読めない行とする。後の SideCheck も同じ決まりで読む
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
