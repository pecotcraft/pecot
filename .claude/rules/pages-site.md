---
paths:
  - ".github/workflows/pages-build.yml"
  - ".github/workflows/pages-deploy.yml"
  - ".githooks/scripts/pages_site/**"
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
| PR 版 | `https://pecotcraft.github.io/pecot/pr/<番号>/` | 同じリポのブランチの PR を開いたときと、push のたび。ci の tests は待たない |

- リリース版・開発版がまだ無いときは、その URL に案内のページが出る
- PR 版は、PR の checks の `pages / preview` の Details から開く。マージかクローズの後の保管で消える
- どの側も `pages-build.yml` がテストを動かさずに作り、定義書だけを載せる。テストの合否とテストレポートのページは載せない（#648。テスト結果は #645 で Allure Report に替える）

## 起動とやり直し

| したいこと | 打つもの |
|---|---|
| 開発版を作り直す | `gh workflow run pages-build.yml --ref main -f side=dev` |
| リリース版を作り直す | `gh workflow run pages-build.yml --ref main -f side=release` |
| `pages-store` の今の中身を公開し直す | `gh workflow run pages-deploy.yml --ref main` |
| PR 版を作り直す | その PR へ push する |

- 同じ側の `pages-build.yml` の run は、後に起動したものだけが残る。手で起こした開発版は、その後の main への push の run に取り消される
- リリース版は、プラグインごとの最新のタグ（プレリリースを除く）から作る。どれかのタグのコミットに `libs/interface-spec/docs/junit-lanes.json` が無いと、そのタグの名前を出して止まる
- 公開されないときは、`pages-deploy.yml` の run の verify の job summary を読む。受けた run・側・採否と、捨てた理由が出る
  - job summary は API で読めない。手元で読むときは、同じ判定を次のコマンドで出す（API を読むだけ）

    ```bash
    python3 .githooks/scripts/pages_site/verify.py --run-id <run> --repo pecotcraft/pecot --out <作業ディレクトリ>
    ```

- 側を作る run は、テストの結果に左右されない。失敗するのは、`sphinx-build -W` が警告を出したときなど、サイトを作れなかったとき
- artifact は、どの側のものも 7 日で消える。保管が終わっていれば、消えても公開は変わらない
- 保管の job が落ち続けて artifact が消えたら、開発版とリリース版を上の起動で作り直す

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
