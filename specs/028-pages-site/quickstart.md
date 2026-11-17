# Quickstart: 公開サイトの確かめ方

URL と workflow の入出力は [contracts/pages.md](contracts/pages.md)、状態の決め方は [data-model.md](data-model.md) を見る。

## 前提

- GitHub Pages の公開元を「GitHub Actions」にしてある（Settings → Pages → Build and deployment → Source）
- 保管ブランチ・environment・deploy key・ruleset を、contracts の「保管ブランチ・environment・ruleset」の表のとおりに設定してある
  - environment `github-pages`・`pages-store` のデプロイ先は、種類をブランチにした `main` だけ
  - `pages-store` の ruleset の bypass は DeployKey、リリースのタグの ruleset の bypass は PECOT_BOT の App
- 公開の運用は、このリポだけで動く。検証用（`pecotcraft/pecot-sandbox`）に確かめる場所は作らない（`plugins/pecot-workflow/CONTRIBUTING.md` の「このリポだけの運用」）

## 1. 手元で、公開と同じ出し方を見る（US4）

```bash
# 合否のレーンを動かす（junit-lanes.json の target を全部）
pnpm exec nx run-many -t test-cli test-hooks --projects=pecot-workflow,pecot-tools,pecot-visual

# サイトを作る
pnpm exec nx run interface-spec:docs

python3 -m http.server -d libs/interface-spec/docs/_build
```

期待:

- どのページの上にも、版の帯（「手元」・手元の HEAD の短い ID・各プラグインの版・作った時刻）が出る。実行へのリンクは出ない
- トップに、プラグインごとの状態ごとの件数がある
- 項目の状態が、記号と文字で出る。落ちた項目に、ケースの名前と要旨がある
- 一部のレーンだけ動かして作っても失敗しない。動かしていないプラグインの項目は「未実行」

```bash
PECOT_SITE_STRICT=1 pnpm exec nx run interface-spec:docs
```

期待: JUnit が欠けたレーンがあれば、そのレーンの名前を出して失敗する。

## 2. workflow の形（PR の CI で動く）

```bash
uv run pytest .githooks/tests/test_pages_workflows.py -q
```

期待: 権限・契機・concurrency・environment・使う action の版が contracts と合う。build の job が動かすレーンが `junit-lanes.json` から決まる。`actions: write` を持つ job が無い。

出どころの確かめと保管の判定は、GitHub の API の応答の実物の形を入力にしたテストで確かめる。

```bash
uv run pytest .githooks/tests/test_pages_provenance.py .githooks/tests/test_pages_store.py .githooks/tests/test_pages_release.py -q
```

## 3. 開発版の公開（マージの後）

1. `pages-build.yml` と `pages-deploy.yml` を入れた PR をマージする
2. main への push で `pages-build.yml` が動き、その完了で `pages-deploy.yml` が動くことを、`gh run list -w pages-deploy.yml -L 1` で見る
3. `https://pecotcraft.github.io/pecot/dev/` を開く

期待: 帯の側が「開発版」、コミットがマージのコミット。「未実行」の項目が 0 件。`pages-store` の `dev/` だけが書き換わり、リリース版がまだ無ければ `/pecot/` に案内のページがある。

時間（SC-001）: `gh run list -w pages-build.yml -L 1 --json createdAt` と `gh run list -w pages-deploy.yml -L 1 --json updatedAt` を見て、push から公開の終わりまでが 30 分以内であることを確かめる。

## 4. リリース版の公開

```bash
gh workflow run pages-build.yml --ref main -f side=release
```

期待:

- `https://pecotcraft.github.io/pecot/` の帯が「リリース版」になる
- 帯の各プラグインの版とコミットが、そのプラグインの最新のタグと、そのタグが指すコミットになる（`git tag --sort=-v:refname -l '<plugin>-v*'`）
- `/dev/` と `/pr/` は変わらない
- 次の本番のリリースからは、release.yml が land の後に同じように起動する

## 5. PR 版（PR 版を入れた PR のマージの後）

`pages-deploy.yml` は `workflow_run` で動くので、既定のブランチの定義で動く。PR 版の確かめは、PR 版の組み立てがマージされてからになる。

1. 同じリポのブランチから、`libs/interface-spec/docs/` の文言を 1 か所変えた PR を開く
2. PR の checks に `pages / preview` が付くのを待ち、Details を開く

期待:

- `https://pecotcraft.github.io/pecot/pr/<番号>/` が開き、帯が「PR #<番号>」と head のコミット
- 変えた文言が出ている
- head に push すると、同じ URL の中身が新しいコミットに変わる。push から公開の終わりまでが 30 分以内（SC-007。3 と同じく run の時刻で見る）
- PR を閉じると、次の保管で `/pr/<番号>/` が 404 になる。`/` と `/dev/` は変わらない

## 6. 止まる場合

| 起こすこと | 期待 |
|---|---|
| 合否のレーン 1 つの target を壊した PR を出し、JUnit が残らないようにする | 作る run が失敗し、PR 版は前のまま |
| 同じリポのブランチの PR で、`pages-build.yml` を書き換え、`pages-side-dev` の名前で artifact を上げる | `pages-deploy.yml` の verify が、run の `event` が `pull_request` なので PR 版として扱う。`pages-store` の `dev/` は変わらず、summary に側の判定が出る |
| `main` という名前のタグを main に無いコミットへ付け、そのタグで `pages-build.yml` を `side=dev` で起こした run | verify が、`head_sha` が main の祖先でないとして捨てる。このリポにタグは作らず、タグで動いた run の応答の形（`head_branch` にタグ名が入る）を入力にした `test_pages_provenance.py` で確かめる |
| 保管の job が 7 日より長く落ち続けた | その間の側の artifact は消える。開発版とリリース版は `gh workflow run pages-build.yml --ref main -f side=<dev か release>` で作り直す。PR 版は、その PR へ次に push したときに作り直される |
