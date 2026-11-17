# Implementation Plan: pecot の文書サイトを GitHub Pages で公開し、インタフェース定義書と合否をそこで読める

**Branch**: `028-pages-site` | **Date**: 2026-11-17 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/028-pages-site/spec.md`

## Summary

`libs/interface-spec/docs` の Sphinx のサイトを、リリース版（`/`）・開発版（`/dev/`）・PR 版（`/pr/<番号>/`）の 3 種の側に分けて GitHub Pages に公開する。

GitHub Pages の Actions 方式は、1 回の deploy でサイト全体を差し替える。そこで、各側を保管ブランチ `pages-store` に置き、その全体を公開する。側を作る run（`pages-build.yml`）と、確かめて保管し公開する run（`pages-deploy.yml`）に分ける。

- 作る run は、合否のレーン（今は 4 本）を dev container の 1 つの job で順に動かし、JUnit がそろったときだけ側の HTML を artifact に上げる。書き込みの権限は持たない
- 公開する run は、既定のブランチの文脈で `workflow_run` から動く。受けた run の出どころを API で確かめ、`pages-store` のその側のディレクトリだけを差し替え、公式の `deploy-pages` で公開する
- リリース版は、各プラグインの最新のタグの時点で作る

2026-11-17 の 2 回目の決め直し（#616）で、公開元・リリース版の定義・公開の段の安全の決まりを直した。理由は research.md の R1〜R6・R12・R13。

テストの結果の出し方は、`iface_defs` 拡張を直して、状態を 5 つに分け、落ちたケースの要旨を出す。全ページの上には版の帯を出す。

調べた結果と判断の理由は [research.md](research.md) にある。

## Technical Context

**Language/Version**: Python 3（Sphinx の拡張と `conf.py`、uv の `libs/interface-spec/docs/pyproject.toml`）、GitHub Actions の YAML、
Python 3（`.githooks/scripts/pages_site/` のレーンの一覧・リリース版の材料・出どころの確かめ・保管。pyright strict にかける）

**Primary Dependencies**: Sphinx・sphinx-needs・sphinx-test-reports・sphinxawesome_theme（今の docs のまま）。
actions/configure-pages・actions/upload-pages-artifact v5・actions/deploy-pages v5・actions/upload-artifact・actions/download-artifact v8（SHA で固定する。
ci.yml と同じ形）

**Storage**: 側の HTML は、保管ブランチ `pages-store`（deploy key と ruleset で守る）。作る run の artifact は受け渡しのためだけで、`retention-days: 7`

**Testing**: pytest（`libs/interface-spec/docs/tests` の拡張のテスト、`.githooks/tests` の workflow の形と組み立てのスクリプトのテスト）。actionlint（pre-commit の既存の hook）

**Target Platform**: GitHub Actions の ubuntu-latest と、ci.yml と同じ dev container。公開先は GitHub Pages（`https://pecotcraft.github.io/pecot/`）

**Project Type**: リポの運用の仕組み（workflow とスクリプト）と、配布しないライブラリ（`libs/interface-spec`）の文書サイト

**Performance Goals**: push・リリース・PR の push から 30 分以内に該当の側が変わる（SC-001・SC-007）。合否のレーンは並べて動かし、今の値で 7 分前後

**Constraints**: 公開サイト全体で 1 GB 以内（今の 1 つの側は約 14 MB）。deploy は 10 分以内。fork の PR では作らない。`pull_request_target` を使わない。手での起動は任意の SHA を受けない。`actions: write` をどの job にも持たせない

**Scale/Scope**: 側は 2 つと開いている PR の数。合否のレーンは 4 本（`junit-lanes.json`）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 判断 | 理由 |
|---|---|---|
| I. DDD | 合格 | 状態の決め方（`outcome_of` など）は拡張の中の純粋な関数に置き、JUnit・JSON の読み込みと分ける。公開のスクリプトは、判定の部分（`provenance.py`・`release_sources.py`。API の応答を受けて決めるだけ）と、I/O の部分（`store.py`。artifact を取る・展開する・push する）を分ける |
| II. TDD | 合格 | 5 つの状態・版の帯・`junit-lanes.json` の読み込みは pytest を先に書く。出どころの確かめ（RunProvenance）とリリース版の材料（ReleaseSources）は、GitHub の API の応答の実物の形を入力にしたテストで確かめる。モックは API を叩く境界だけ。workflow の形は `.githooks/tests` の pytest で確かめる。テストの通過とは別に、quickstart の手順を実物で動かす |
| III. 品質ゲート | 合格 | Python は pyright strict と ruff、workflow は actionlint・yamllint（既存の pre-commit）。`.githooks/scripts` の JS には型検査が無いので、新しい処理は JS で書かない。`.githooks/scripts/pages_site/` の Python は、`githooks-lint`（pyright strict）の範囲を広げてかける |
| IV. YAGNI | 合格 | 過去のリリースは残さない。外部リンクの確認・PR 版の数の上限・新しい保管場所は作らない。プラグインの紹介の文章は書かない |
| V. 本体優先 | 合格 | speckit の成果物はこの一式の作成だけ |
| VI. 標準準拠 | 合格 | 公開は docs が推奨する Actions 方式と公式の 3 つの action。environment `github-pages` に既定のブランチだけの保護、concurrency は starter workflow の値。PR の run からは deploy せず、保護を緩めない。`pull_request_target` を使わない。`workflow_run` で受ける run は API の項目で出どころを確かめ、artifact は untrusted として展開とパスの確かめだけにする（GitHub Security Lab の推奨）。公式の `preview` は alpha で非公開なので使わない。保管ブランチと公式の `deploy-pages` の組み合わせには公式の参照実装が無いが、どちらも公式の形で、組み合わせ方は research R1 に書いた。不適合として残すものは無い |

Phase 1 の後の再確認（2026-11-17 の 2 回目）: 合格。
contracts の権限は job ごとに最小にした。
信頼できない中身を扱う verify の job（`contents: read`・`actions: read`・`pull-requests: read`）と、書き込む job を分けた。
書き込む job は、保管（environment `pages-store` の deploy key）・公開（`pages: write`・`id-token: write`）・status（`statuses: write`）の 3 つ。
`actions: write` はどの job にも持たせない。

## Project Structure

### Documentation (this feature)

```text
specs/028-pages-site/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── pages.md
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks が作る
```

### Source Code (repository root)

```text
libs/interface-spec/
├── docs/
│   ├── junit-lanes.json          # 新規: 合否のレーンと JUnit のパスの 1 か所の定め
│   ├── conf.py                   # 変更: iface_junit を junit-lanes.json から作る。PECOT_SITE_* を html_context へ
│   ├── _ext/iface_defs.py        # 変更: 5 つの状態、落ちたケースの要旨、状態ごとの数、全体の合否、STRICT
│   ├── _templates/header.html    # 変更: 版の帯と側の行き来
│   ├── _static/pecot.css         # 変更: 帯と状態の記号の見た目
│   ├── index.rst                 # 変更: 全体の合否
│   └── tests/test_iface_defs.py  # 変更: 上のテスト
├── project.json                  # 変更: docs の description を今の形に合わせる
└── README.md                     # 変更: 公開サイト・帯・STRICT・CI の artifact の節を書き直す

.github/workflows/
├── pages-build.yml               # 新規（#588）・変更: 側を作る。job を side と build の 2 つにし、手での起動とリリース版を足す
├── pages-deploy.yml              # 新規: 確かめて保管し、公開する（verify・store・deploy・preview-status）
└── release.yml                   # 変更: 本番の land の後に pages-build を起こす

.githooks/
├── scripts/pages_site/
│   ├── lanes.py                  # 新規: junit-lanes.json からレーンの一覧を出す
│   ├── release_sources.py        # 新規: タグから ReleaseSources を決める
│   ├── provenance.py             # 新規: API の応答から RunProvenance を判定する純粋な処理
│   ├── store.py                  # 新規: SideCheck と、pages-store の差し替え・掃除・大きさ（I/O）
│   └── pyrightconfig.json        # 新規: pyright strict の設定
├── scripts/run-lint.sh           # 変更: pages_site も pyright strict にかける
└── tests/
    ├── test_pages_lanes.py       # 新規: レーンの一覧
    ├── test_pages_workflows.py   # 新規: workflow の形
    ├── test_pages_release.py     # 新規: ReleaseSources
    ├── test_pages_provenance.py  # 新規: RunProvenance
    └── test_pages_store.py       # 新規: SideCheck と StoreLayout

保管ブランチ・environment・ruleset（リポの管理者の設定。ファイルではない）
├── pages-store ブランチと、その ruleset（bypass は DeployKey）
├── deploy key（書き込みのできるものは 1 本だけ）
├── environment pages-store・github-pages（デプロイ先は main のブランチだけ）
└── リリースのタグ（*-v*）の ruleset（bypass は PECOT_BOT の App）

.pre-commit-config.yaml           # 変更: githooks-lint の files に pages_site を足す

plugins/pecot-workflow/CONTRIBUTING.md  # 変更: 「このリポだけの運用」に公開サイトの行を足す
README.md                                # 変更: 公開サイトへのリンク
```

**Structure Decision**: サイトの中身は今の `libs/interface-spec/docs` に置いたまま直す。リポ全体で使うスクリプトは `.githooks/scripts/`、テストは `.githooks/tests/` に置く（`.claude/rules/repo-root-layout.md`）。ルートに新しいディレクトリは作らない。

## 段階

各段は、前の段が無いと確かめられないものを後ろに置く。

1. **出し方**（US2・US4）: 5 つの状態・要旨・状態ごとの数・全体の合否・版の帯・`junit-lanes.json`・STRICT。手元の `interface-spec:docs` で確かめられる
2. **作る run**（US1 の前半）: `pages-build.yml`。PR の上で、`pull_request` の契機で PR 版の artifact ができることまで確かめられる
3. **確かめて保管し公開する run**（US1）: `pages-deploy.yml` と、出どころの確かめ・保管のスクリプト、`pages-build.yml` の手での起動とリリース版、保管ブランチ・environment・ruleset の設定、release.yml の追加。`workflow_run` は既定のブランチの定義で動くので、公開の確かめは 2 と 3 がマージされた後になる
4. **PR 版の公開**（US3）: 確かめと保管に PR 版と commit status を足す。確かめは 3 のマージの後
5. **文書**: README・CONTRIBUTING・interface-spec の README

## Complexity Tracking

憲章の違反は無い。
