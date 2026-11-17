# Quickstart: 公開サイトの確かめ方

URL と workflow の入出力は [contracts/pages.md](contracts/pages.md)、状態の決め方は [data-model.md](data-model.md) を見る。

## 前提

- GitHub Pages の公開元を「GitHub Actions」にしてある（Settings → Pages → Build and deployment → Source）
- environment `github-pages` の deployment branch を、既定のブランチだけにしてある
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

期待: 権限・契機・concurrency・environment・使う action の版が contracts と合う。合否のレーンの matrix が `junit-lanes.json` から決まる。

## 3. 開発版の公開（マージの後）

1. `pages-build.yml` と `pages-deploy.yml` を入れた PR をマージする
2. main への push で `pages-build.yml` が動き、その完了で `pages-deploy.yml` が動くことを、`gh run list -w pages-deploy.yml -L 1` で見る
3. `https://pecotcraft.github.io/pecot/dev/` を開く

期待: 帯の側が「開発版」、コミットがマージのコミット。「未実行」の項目が 0 件。

## 4. リリース版の公開

```bash
gh workflow run pages-build.yml --ref main -f side=release -f sha=<最新のリリースのコミット>
```

期待: `https://pecotcraft.github.io/pecot/` の帯が「リリース版」と指定のコミットになる。`/dev/` は変わらない。次の本番のリリースからは、release.yml が同じように起動する。

## 5. PR 版（PR 版を入れた PR のマージの後）

`pages-deploy.yml` は `workflow_run` で動くので、既定のブランチの定義で動く。PR 版の確かめは、PR 版の組み立てがマージされてからになる。

1. 同じリポのブランチから、`libs/interface-spec/docs/` の文言を 1 か所変えた PR を開く
2. PR の checks に `pages / preview` が付くのを待ち、Details を開く

期待:

- `https://pecotcraft.github.io/pecot/pr/<番号>/` が開き、帯が「PR #<番号>」と head のコミット
- 変えた文言が出ている
- head に push すると、同じ URL の中身が新しいコミットに変わる
- PR を閉じると、次の公開で `/pr/<番号>/` が 404 になる。`/` と `/dev/` は変わらない

## 6. 止まる場合

| 起こすこと | 期待 |
|---|---|
| 合否のレーン 1 つの target を壊した PR を出し、JUnit が残らないようにする | 作る run が失敗し、PR 版は前のまま |
| リリース版の artifact を消す（`gh api -X DELETE repos/pecotcraft/pecot/actions/artifacts/<id>`） | `pages-deploy.yml` が失敗し、`pages-build.yml` の release の run が起き、その完了で公開される |
