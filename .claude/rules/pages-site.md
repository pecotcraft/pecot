---
paths:
  - ".github/workflows/pages-build.yml"
  - ".github/workflows/pages-deploy.yml"
  - ".github/workflows/test-report.yml"
  - ".githooks/scripts/pages_site/**"
  - ".githooks/scripts/test_report/**"
  - ".github/rulesets/pages-store.json"
  - ".github/rulesets/release-tags.json"
  - "libs/interface-spec/docs/**"
---

# 公開サイトの起動・やり直しと、管理者の設定

公開サイトは GitHub Pages で、公開元は保管ブランチ `pages-store` の全体。決まりの正は `specs/028-pages-site/contracts/pages.md`、確かめの手順は同じ場所の `quickstart.md`。workflow の役割は `.claude/rules/github-workflows.md` の一覧にある。

| 側 | URL | 作られるとき |
|---|---|---|
| リリース版 | `https://pecotcraft.github.io/pecot/` | 本番のリリースの land の後（release.yml が起こす） |
| 開発版 | `https://pecotcraft.github.io/pecot/dev/` | main への push |
| PR 版 | `https://pecotcraft.github.io/pecot/pr/<番号>/` | サイトの材料に触る、同じリポのブランチの PR を開いたときと、push のたび。ci の tests は待たない |

- サイトの材料は、`pages-build.yml` の `on.pull_request.paths` にある。材料に触らない PR には、PR 版と `pages / preview` が出ない
  - `paths` は PR の diff の最初の 300 ファイルしか見ない。材料が 301 番目以降にある大きな PR では、PR 版が作られない
- リリース版・開発版がまだ無いときは、その URL に案内のページが出る
- PR 版は、PR の checks の `pages / preview` の Details から開く。マージかクローズの後の保管で消える
- 定義書は、どの側も `pages-build.yml` がテストを動かさずに作る
- テストレポートは、`pages-deploy.yml` が `test-report.yml` の run を受けて、開発版・リリース版の `test-report/` に置く。PR 版には置かない。起動と保守は「テストレポート」の節にある

## 起動とやり直し

| したいこと | 打つもの |
|---|---|
| 開発版を作り直す | `gh workflow run pages-build.yml --ref main -f side=dev` |
| リリース版を作り直す | `gh workflow run pages-build.yml --ref main -f side=release` |
| `pages-store` の今の中身を公開し直す | `gh workflow run pages-deploy.yml --ref main` |
| PR 版を作り直す | その PR へ push する |

- 同じ側の `pages-build.yml` の run は、後に起動したものだけが残る。手で起こした開発版は、その後の main への push の run に取り消される
- リリース版は、プラグインごとの最新のタグ（プレリリースを除く）から作る
- 公開されないときは、`pages-deploy.yml` の run の verify の job summary を読む。受けた run・側・採否と、捨てた理由が出る
  - job summary は API で読めない。手元で読むときは、同じ判定を次のコマンドで出す

    ```bash
    python3 .githooks/scripts/pages_site/verify.py --run-id <run> --repo pecotcraft/pecot --out .pecot/work/<Issue番号>/verify
    ```

  - 受ける run なら、artifact を `--out` の親の `pages-raw` に落とし（前の中身は消す）、`--out` に写す。`--out` は、上のように `.pecot/work/<Issue番号>/` の 1 段下にする

- `pages-deploy.yml` の deploy の job が `No artifacts named "github-pages"` で落ちたら、後の run の deploy が通っているかを見る

  ```bash
  gh run list -R pecotcraft/pecot -w pages-deploy.yml -L 5
  ```

  - 後の run の deploy が通っていれば、公開は追いついているので、やり直さない。落ちた run が PR 版で、`pages / preview` が付いていなければ、その PR へ push する
  - 後に通った run が無ければ、失敗した job だけをやり直す。全 job をやり直すと store が上げ直し、`github-pages` が 2 つになって落ちる

    ```bash
    gh run rerun <run> -R pecotcraft/pecot --failed
    ```

  - 落ちた run の artifact は、store の job が取った時点の `pages-store` なので、後の run の後にやり直すと古い中身を公開する
  - `github-pages` の artifact は 1 日で消える。過ぎたら `gh workflow run pages-deploy.yml --ref main` を打つ

- deploy の job は、公開の後に目印 `pages-version.txt` を読み戻し、出そろうまで待つ。出そろわなければ 60 秒待って 1 回 deploy し直す。決まりは `specs/028-pages-site/contracts/pages.md` の「公開の確かめ」
  - `Redeploy to GitHub Pages` が動いた run は、最初の deploy の作成が断られたか、成功を報告しても公開されなかった run。ログの `Check served` の行に、読んだ値と `x-cache` が出る
  - `Check redeployed` で落ちたら、deploy し直しても公開されていない。後に通った run が無ければ、`gh workflow run pages-deploy.yml --ref main` で `pages-store` の今の中身を公開し直す
  - 公開中の目印は、次のコマンドで読む。CDN の写しを避けるため、ファイル名の文字を符号化する

    ```bash
    curl -s https://pecotcraft.github.io/pecot/pages-versio%6E.txt
    ```

- store の job が、保管の push の後に上げる step で落ちたときも、上の `--failed` でやり直す。やり直しの store は、保管の変更が無くても `pages-store` の今の中身を上げる

- 側を作る run は、テストの結果に左右されない。失敗するのは、`sphinx-build -W` が警告を出したときなど、サイトを作れなかったとき
- artifact は、どの側のものも 7 日で消える。保管が終わっていれば、消えても公開は変わらない
- 保管の job が落ち続けて artifact が消えたら、開発版とリリース版を上の起動で作り直す

## テストレポート

テストレポートは Allure Report で、`test-report.yml` がレポートのレーンを動かして作る。レポートのレーンは、`.githooks/scripts/test_report/report-lanes.json` の `results` を持つ 22 本。
決まりの正は `specs/030-allure-test-report/contracts/test-report.md`、確かめの手順は同じ場所の `quickstart.md`。

| 側 | URL | 作られるとき |
|---|---|---|
| リリース版 | `https://pecotcraft.github.io/pecot/test-report/` | 本番のリリースの land の後（release.yml が `side=release` で起こす） |
| 開発版 | `https://pecotcraft.github.io/pecot/dev/test-report/` | main への push |

- 定義書の振る舞いの項目の「テスト」は `test-report/index.html?tags=<ID>` を開き、その ID のテストだけを出す。レポートのテストの要件の ID は、その側の `permalink.html?id=<ID>` へ戻る
- 開発版は、main でテストを流し直さずに作る。材料は、PR の CI とマージキューの run が上げた結果と、前の開発版の run が持ち回す結果（artifact `lane-latest`）。main で流すのは、結果の無いレーンと、マージキューを通らないコミット（リリースの land）で変わったレーンだけ
  - 各レーンの結果のコミットと、試した run の URL は、レポートの先頭の変数に出る
- 履歴はリリース版だけが持ち、3 回分（`allurerc.mjs` の `historyLimit`）で、`test-report/history.jsonl` に 1 回 1 行で残る。開発版は履歴を持たない
- テストの「履歴」のタブは、前の回までを並べる。今の回は並ばない
- レポートが無い側には「テストレポートはまだありません」の案内のページが出る
- リリース版では、結果を出せるタグの無いプラグインはレポートに入らず、その名前をフッターのリンクのそばに出す。そういうプラグインしか無いときの動きは、下の「起動とやり直し」の節にある
  - 結果を出せるタグ: そのコミットの `report-lanes.json` に、そのプラグインのレーンで `results` を持つものがあるタグ

### レポートが公開されるまでの時間

2026-11-26 に測った値。開発版は 3 回（#698・#704 の push と、手での起動）で測った。リリース版は、pecot-workflow v10.0.0 と pecot-visual・pecot-tools v3.1.0 のリリースの 1 回で測った。

| 区間 | 開発版 | リリース版 |
|---|---|---|
| `test-report.yml` の run（最初の job の開始から最後の job の終わりまで） | 6 分 48 秒〜10 分 48 秒 | 10 分 20 秒 |
| 同じ run の、起動から最後の job の終わりまで | 10 分 53 秒〜18 分 49 秒 | 10 分 35 秒 |
| 結果がそろってから公開が変わるまで（最後の tests の job の終わりから、`pages-deploy.yml` の deploy の job の終わりまで） | 2 分 57 秒〜5 分 35 秒 | 3 分 37 秒 |
| `pages-deploy.yml` の deploy の job | 26 秒〜30 秒 | 46 秒 |

- deploy の job の値は、upload と deploy が 1 つの job だったとき（#804 で分ける前）に測った
- run の実行の時間が長いのは、どちらの側も `pecot-workflow:test-cli` の tests の job
- 起動からの時間には、前の run の終わりを concurrency で待つ時間が入る
- 結果がそろってから公開が変わるまでは、どの回も SC-008 の 30 分に収まる。開発版の長い回は、PR 版の保管と同時に動き、store の job が待った。リリース版の回は、ほとんど report・verify・store・deploy の job の時間で、job の間の空きは合わせて 27 秒だった
- deploy の job は、`actions/deploy-pages` に渡す `timeout`（300000 ms）に余裕がある。公開の確かめを足した後（#872）は、出そろうまでの 30 秒ほどが加わる
- リリース版で測った run
  - `release.yml` が起こした `test-report.yml` の run 45750823897
  - それを受けた `pages-deploy.yml` の run 45751913227

- Pages の応答は `cache-control: max-age=600` なので、deploy の後の 10 分ほどは、前の中身を返すことがある。`index.html` の `last-modified` で、新しい中身かを見分ける
  - CDN は問い合わせの文字列（`?x=1`）を見ずに写しを返す。写しを避けて読むときは、`%69ndex.html` のようにファイル名の文字を符号化する。応答の `x-cache: MISS` で、写しでないことが分かる

### 起動とやり直し

| したいこと | 打つもの |
|---|---|
| 開発版のレポートを作り直す | `gh workflow run test-report.yml --ref main -f side=dev` |
| リリース版のレポートを作り直す | `gh workflow run test-report.yml --ref main -f side=release` |

- どちらも main からだけ起動できる。コミットは指定できず、開発版は main の先頭、リリース版はプラグインごとの最新のタグで作る
- 開発版の作り直しも、全レーンを流し直さない。push の run と同じく、結果の無いレーンだけを流す。前の開発版の run の artifact が 90 日で消えた後と、初めての run は、全レーンを流す
- 同じ側の run は、動いているものを取り消さず、後の run が待つ。待っている run は、さらに新しい run に置き換わる。待っている手での起動は、開発版なら main への push の run に、リリース版なら `release.yml` が起こす run に置き換わることがある。取り消されたら打ち直す
- テストが落ちても run は成功で終わり、落ちたテストがレポートに載る
- run が落ちるのは、main 以外から起こしたとき、`release_sources.py` が材料を決められなかったとき、`allure generate` が失敗したとき
- 結果を残さずに止まったレーンか、結果のコミットが材料と違うレーンがあるときも落ちる（ResultsCheck）
- リリース版で、結果を出せるタグを持つプラグインが無いときは、side の job だけが動いて成功で終わる。レポートは作らず、公開も変わらない
- 開発版は、保管中のレポートより古いコミットの run を保管しない

### レポートが出ないときに読む所

| 読む所 | 分かること |
|---|---|
| `test-report.yml` の side の job summary | リリース版に入れないプラグインと、レポートを作らなかったこと |
| `test-report.yml` の side の job のログ（開発版） | コミットごとの判定。各レーンの結果を、どの run から拾ったか・main で流すのはなぜか |
| `test-report.yml` の report の job のログ | 結果の欠けたレーンと、結果のコミットが材料と違うレーンの名前（ResultsCheck） |
| `test-report.yml` の report の job summary | `pages-store` を読めなかったか、`history.jsonl` に読めない行があったので、空の履歴で作ったこと |
| `pages-deploy.yml` の verify の job summary | 受けた run の種類（定義書かレポート）・側・採否と、捨てた理由 |

- job summary は API で読めず、ログインしないと画面にも出ない。手元で同じ判定を出すときは、次のコマンドを打つ。`release_sources.py` は読むだけで、`verify.py` は上の「起動とやり直し」の節のとおり `pages-raw` に落とす

  ```bash
  # side の job と同じ判定（リリース版の材料）
  python3 .githooks/scripts/pages_site/release_sources.py --report release --main origin/main
  # side の job と同じ判定（開発版の材料。API を読むだけ）
  python3 .githooks/scripts/test_report/dev_sources.py resolve --head origin/main --repo pecotcraft/pecot
  # verify の job と同じ判定
  python3 .githooks/scripts/pages_site/verify.py --run-id <test-report.yml の run> --repo pecotcraft/pecot --out .pecot/work/<Issue番号>/verify
  ```

- 保管の push は、`store.py` が出力を捨てるので、GitHub が出す 50 MB 超の警告はログに出ない。大きさは次のコマンドで読む。手元の clone は `pages-store` を取らないので、API で読む。`history.jsonl` は 3 行で約 64 MB

  ```bash
  sha=$(gh api 'repos/pecotcraft/pecot/contents/dev?ref=pages-store' --jq '.[] | select(.name=="test-report") | .sha')
  gh api "repos/pecotcraft/pecot/git/trees/$sha?recursive=1" --jq '.tree[] | select(.type=="blob") | "\(.size)\t\(.path)"'
  ```

### 手元でレポートを作る

```bash
# 見たいレーンを動かす（例: pecot-tools:test-cli）
pnpm exec nx run pecot-tools:test-cli
python3 .githooks/scripts/test_report/generate.py --local --output <作業ディレクトリ>
pnpm exec allure open <作業ディレクトリ>
```

- 結果の無いレーンは、名前を出して飛ばす。結果のあるレーンが 1 つも無ければ止まる
- 履歴は読まず、書かない。要件の ID のリンクは `http://localhost:8000/` を指す

### Allure の版を上げるとき

`package.json` の `allure` を上げたら、次を見る。

| 見る所 | 理由 |
|---|---|
| `libs/interface-spec/tests/site/report-links.test.ts` | `?tags=` の絞り込みと、要件の ID のリンクを、作ったレポートを Chromium で開いて確かめる |
| `.githooks/tests/test_report_generate.py` の `test_real_allure_keeps_history_of_a_test_name_with_line_separator` | 3.33.0 は、U+2028・U+2029 を含む履歴を次の回に読めない。`generate.py` がエスケープしている |
| `generate.py` の `read_history`・`_LINE_BREAK`・`_JS_TRIM` | Allure の履歴の読み方（readline と `trim()`）を写している。`store.py` の確かめも使う |
| `allurerc.mjs` の `groupBy`・`reportLanguage`・`historyLimit` | 木の段・画面の言葉・履歴の数が変わりうる |
| `allurerc.mjs` の `categories` と、`.githooks/tests/test_report_generate.py` の `test_real_allure_sorts_failures_into_categories_by_epic` | 規則の形（`matchers`）と当てる順、結果の無い既定の分類を出さない扱いが変わりうる |
| `.githooks/tests/test_report_generate.py` の `test_real_allure_shows_only_environment_values_shared_by_all_lanes`・`test_real_allure_shows_no_environment_when_no_key_is_shared` | `generate.py` の環境の情報のまとめは、Allure の読み方に頼っている。結果のディレクトリを渡した順に読み、`environment.properties` を読むたびにメタデータを置き換え、コメントだけのファイルで空にする |
| `.githooks/scripts/test_report/allure-result.sh` と、`test_bash_test_lib.py`・`test_bats_report.py` の `test_real_allure_reads_the_results` | bash のテストの結果のファイルは手で書いている。Allure の読み手が読む欄が変わりうる |
| `@allurereport/web-commons` の `generateTestingPyramidChart` の `DEFAULT_LAYERS` と、`@allurereport/charts-api` の `defaultChartsConfig` の `groupBy: "layer"` | テストのピラミッドと層ごとの時間のグラフは、`layer` の値（`test-layers.txt` の層）で集める。層の名前と、既定のグラフの有無が変わりうる。`allurerc.mjs` に `charts` を書くと、既定のグラフは消える |

## 管理者の設定

リポの管理者が設定する。エージェントは打つコマンドと画面の場所を示し、ユーザーが操作する。

| 対象 | 場所 | 値 |
|---|---|---|
| GitHub Pages | Settings → Pages → Build and deployment → Source | 「GitHub Actions」 |
| `pages-store` の ruleset | `.github/rulesets/pages-store.json` | 作成・更新・削除を止める。bypass は pages-store の App だけ |
| リリースのタグの ruleset | `.github/rulesets/release-tags.json` | `*-v*` の作成・更新・削除を止める。bypass は PECOT_BOT の App だけ |
| pages-store の App | org の Settings → Developer settings → GitHub Apps → `pecotcraft-pages-store` | 権限は Contents: write だけ。Webhook なし。このリポにだけ入れる |
| environment `pages-store` | Settings → Environments → `pages-store` | 変数 `PAGES_STORE_APP_CLIENT_ID` と secret `PAGES_STORE_APP_PRIVATE_KEY`。デプロイ先は「Selected branches and tags」で、種類が Branch の `main` だけ |
| environment `github-pages` | Settings → Environments → `github-pages` | デプロイ先は、種類が Branch の `main` だけ |

- ruleset を変えるときは、JSON を直してから次のコマンドで入れる。id は `gh api repos/pecotcraft/pecot/rulesets` で読む

  ```bash
  gh api -X PUT repos/pecotcraft/pecot/rulesets/<id> --input .github/rulesets/<名前>.json
  ```

- environment のデプロイ先の種類を Tag にしない。`main` という名前のタグが通る
- `pages-store` へ書くのは pages-store の App だけにする。リリースの App（PECOT_BOT）は main とタグにも書けるので、使わない
- App の秘密鍵は environment `pages-store` の secret にだけ置く。リポの secret には置かない
