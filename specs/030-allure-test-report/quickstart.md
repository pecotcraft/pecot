# Quickstart: テストレポートの確かめ方

URL と workflow の入出力は [contracts/test-report.md](contracts/test-report.md)、値の決まりは [data-model.md](data-model.md) を見る。

## 前提

- 028 の公開サイトの設定（GitHub Pages・`pages-store`・environment・ruleset）が済んでいる
- 公開の運用は、このリポだけで動く。検証用（`pecotcraft/pecot-sandbox`）に確かめる場所は作らない
- 手元は dev container（Node 24.22.1）。`pnpm install` が済んでいる

## 1. 手元で、結果を残してレポートを作る（US1・US4）

```bash
# レポートのレーンを 1 つ動かす
pnpm exec nx run pecot-tools:test-cli

# 結果ができたことを見る
ls plugins/pecot-tools/test-results/test-cli/allure-results | head

# レポートを作って開く
python3 .githooks/scripts/test_report/generate.py --local --output .pecot/work/670/report
pnpm exec allure open .pecot/work/670/report
```

期待:

- 結果のディレクトリに `*-result.json` がある。JUnit XML は、今までと同じ場所に同じ中身である
- `generate.py` は、動かしていないレーンの名前を出して続ける
- レポートのテストの一覧が、テストに書いた題で並ぶ。`project`・`lane` で木になっている
- 落ちたテストを 1 つ用意して動かすと、理由とスタックが出る

pytest のレーンも同じに確かめる。

```bash
pnpm exec nx run githooks:test-nx-cache
ls .githooks/test-results/test-nx-cache/allure-results | head
```

## 2. 要件の ID のつながり（US2）

```bash
# verifies が tms のリンクと tag を残すこと
pnpm exec vitest run --root libs/interface-spec tests/verifies.test.ts

# サイトを作り、項目のリンクを見る
PECOT_SITE_SIDE=dev pnpm exec nx run interface-spec:docs
grep -o 'test-report/index.html?tags=[A-Z0-9-]*' -r libs/interface-spec/docs/_build | head -3

# レポートを ?tags=<ID> で開くと、その ID のテストだけが出ること（実物のレポートを Chromium で開く）
pnpm exec vitest run --root libs/interface-spec --config vitest.site.config.ts tests/site/report-links.test.ts
```

期待:

- 開発版のサイトの振る舞いの項目に、`test-report/index.html?tags=<ID>` のリンクがある。合否の表示は無い
- `PECOT_SITE_SIDE` を付けずに作ると、項目のリンクもフッターのリンクも無い
- レポートのテストを開くと、要件の ID のリンクがあり、`permalink.html?id=<ID>` へ飛ぶ

## 3. 添付（US1 の 6）

```bash
pnpm exec nx run interface-spec:test-site
python3 .githooks/scripts/test_report/generate.py --local --output .pecot/work/670/report
```

期待: レポートで `test-site` の成功したテストを開くと、測ったページの画像がある。pecot-visual の e2e の成功したテストには、判定した PNG・PDF・PPTX がある。

## 4. workflow の形とレーンの定め（PR の CI で動く）

```bash
.githooks/tests/run.sh .githooks/tests/test_report_lanes.py .githooks/tests/test_report_workflow.py .githooks/tests/test_report_generate.py
.githooks/tests/run.sh .githooks/tests/test_pages_provenance.py .githooks/tests/test_pages_store.py
```

期待:

- nx の `test-*` の target が、`report-lanes.json` に全部ある。新しい target を足して定めに書かないと落ちる
- `test-report.yml` の契機に `pull_request` が無い。どの job も `contents: read` だけ
- PR の run のレポートは、出どころの確かめで捨てられる
- 定義書の側を差し替えても `test-report/` が残り、レポートを差し替えても定義書が残る

## 5. 開発版のレポート（マージの後。US1・US3）

1. この機能の PR を main にマージする
2. `test-report.yml` の run が終わり、`pages-deploy.yml` の run が続くのを待つ
3. `https://pecotcraft.github.io/pecot/dev/` を開き、フッターの「テストレポート」を押す

期待:

- レポートに、12 本のレーンのテストがある
- 2 回目の main への push の後、テストの History のタブに 2 件が並ぶ。1 回目と状態が変わったテストに印が付く
- 定義書の開発版は、テストの終わりを待たずに変わっている

手で作り直すとき:

```bash
gh workflow run test-report.yml --ref main -f side=dev
```

## 6. リリース版のレポート（次のリリースの後）

1. この機能が入った後で、プラグインを 1 つリリースする
2. `https://pecotcraft.github.io/pecot/` のフッターを見る

期待:

- リリースする前は、リリース版にテストレポートのリンクが無い。`/pecot/test-report/` には案内のページがある
- リリースした後は、リンクがあり、そのプラグインのテストだけがレポートにある。まだリリースしていないプラグインの名前が、リンクのそばにある
- 開発版のレポートと履歴は変わらない

## 7. 片付け（US4）

```bash
git grep -n -E 'sphinx-test-reports|sphinx_test_reports|PECOT_SITE_RESULTS|junit-lanes' \
  -- '*.py' '*.toml' '*.json' '*.yml' '*.md' ':!specs/'
ls libs/interface-spec/docs/development 2>/dev/null
```

期待: どちらも何も出ない。
