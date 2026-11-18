# interface-spec

インタフェース定義書（`plugins/*/interface/`）の形式と検証。配布しない。

## 定義書と合否の HTML

定義書の全項目と、振る舞いの項目ごとのテストと合否を HTML に出します。`docs/` に sphinx-needs の project があります。

```bash
# 1. JUnit を出す
pnpm exec nx run-many -t test-cli test-hooks --projects=pecot-workflow,pecot-tools,pecot-visual

# 2. HTML を作る（libs/interface-spec/docs/_build）
pnpm exec nx run interface-spec:docs

# 3. 開く（http://localhost:8000/ のトップから入る）
python3 -m http.server -d libs/interface-spec/docs/_build
```

作る HTML の構成は次のとおり。

- トップ（`index.html`）: プラグインごとの一覧と、欄の対応表へのリンク
- プラグインの一覧表: コマンド・ツールごとに、名前（ページへのリンク）・surface・説明・振る舞いの合否の数（「2 passed, 1 not run」の形）を 1 行にする。最後の行は共通の振る舞い。表の下に、そのプラグインのテストの表を置く
- コマンド・ツールごとのページ: 定義書の本文（POSIX の節の順）と、その項目の振る舞いごとの合否・つながるテストケース。`_generated/<plugin>/<名前>.html` にできる
- 共通の振る舞いのページ: 全コマンドに共通の振る舞い。`_generated/<plugin>/_common.html` にできる
- 欄の対応表（`field-map.html`）: 定義書の欄と POSIX の節の対応

`_generated/<plugin>/*.rst` は build のたびに定義書から書き直す。定義書から消えた項目のページは消える。

- 手元で作ったサイトは、どのページの上にも、ローカルでビルドしたことを伝える 1 行の知らせを出す
- JUnit が無くても作れる。JUnit の無いレーンを持つプラグインの項目は「未実行」になる
- 読む JUnit は `docs/junit-lanes.json` に並べている。合否のレーンを足す・外すときは、このファイルを直す
- 前に動かしたレーンの JUnit が残っていれば、それを読む。今の結果だけで作るときは、先に `junit-lanes.json` の `junit` のファイルを消す
- 項目の ID を書いたテスト（`verifies`）だけが、項目につながる。定義書に無い ID のケースは落とす

JUnit がそろっていることを確かめて作るときは、`PECOT_SITE_STRICT=1` を付けます。JUnit が無いか読めないレーンがあると、その名前を出して止まります。公開サイトを作る run は、これを付けて動きます。

```bash
PECOT_SITE_STRICT=1 pnpm exec nx run interface-spec:docs
```

### 見た目のテスト（`test-site`）

`test-site` のレーンは、サイトを一時ディレクトリにビルドし、Chromium で全ページを開いて次の崩れを測ります。

- 幅 1440px・1920px で、目次の無いページの本文の右に空欄が残る。目次の無いページの rst には、テーマの docs のとおり先頭に `:notoc: true` を付ける
- 見出しのリンクが、テーマのアイコンでなく文字の ¶ で出る。カーソルを当てる前から見える
- 幅 390px で、ページが横にはみ出す

```bash
pnpm exec nx run interface-spec:test-site
```

Chromium は pecot-visual と同じ版の playwright のものを使います。devcontainer は作るときに入れています。

ページを足すときは、次のとおりにします。

- 見出しが 1 段で目次の無いページには、rst の先頭に `:notoc: true` を付ける。付け忘れると、右の空欄の測りで落ちる
- 見出しが 2 段以上あり、右に目次が出るページには付けない
- `search.html` はテーマのテンプレートのページで、印を付けられない。右の空欄の測りからだけ外している（`tests/site/layout.test.ts` の `NO_NOTOC`）。¶ とはみ出しは測る

## 公開サイト

サイトは GitHub Pages で公開しています。公開元は保管ブランチ `pages-store` の全体で、3 つの側を持ちます。

| 側 | URL | 作られるとき | 中身 |
|---|---|---|---|
| リリース版 | <https://pecotcraft.github.io/pecot/> | 本番のリリースの後 | プラグインごとの最新のタグの定義書と、そのタグで動かしたテストの合否 |
| 開発版 | <https://pecotcraft.github.io/pecot/dev/> | main への push | その push のコミットの定義書と、合否のレーンを全部動かした結果 |
| PR 版 | `https://pecotcraft.github.io/pecot/pr/<番号>/` | 同じリポのブランチの PR への push | PR の head の定義書と、ci の tests が残した JUnit の合否 |

- リリース版でない側は、ページの上に 1 行の知らせを出す。開発版と PR 版の知らせには、リリース版へのリンクがある
- リリース版・開発版がまだ無いときは、その URL に案内のページが出る
- URL と workflow の入出力の決まりは [`specs/028-pages-site/contracts/pages.md`](../../specs/028-pages-site/contracts/pages.md) が正

### PR 版の見方

- PR の checks に付く `pages / preview` の Details から開く。付くのは、ci の完了の後に PR 版が公開されてから
- PR 版はテストを動かし直さない。ci が動かさなかったレーンは、開発版の JUnit で埋める。埋めたレーンは、ci の `pages-preview` の job summary の「出どころ」の列に出る。ページの上では見分けられない
- PR 版の失敗は `ci-result` に入らないので、マージを止めない
- PR をマージするか閉じると、次の保管で `pr/<番号>/` が消える
- fork の PR と merge queue では、PR 版を作らない

### 公開の流れ

1. 側を作る。開発版とリリース版は `pages-build.yml`、PR 版は `ci.yml` の `pages-preview` が作り、artifact `pages-side-<側>` に上げる
2. その run の完了で `pages-deploy.yml` が動く。verify が run の出どころを GitHub の API で確かめ、store が `pages-store` のその側だけを差し替え、deploy が GitHub Pages に公開する
3. PR 版では、公開の後に preview-status が PR の head へ `pages / preview` を付ける

公開されないときは、`pages-deploy.yml` の run の verify の job summary を読みます。受けた run・側・採否と、捨てたときの理由が出ます。
側を作る run が失敗しているときは、その run の job summary とログを読みます。合否のレーンのテストが落ちただけでは失敗にならず、JUnit が残らなかったときに失敗します。

### 起動とやり直し

| したいこと | 打つもの |
|---|---|
| 開発版を作り直す | `gh workflow run pages-build.yml --ref main -f side=dev` |
| リリース版を作り直す | `gh workflow run pages-build.yml --ref main -f side=release` |
| `pages-store` の今の中身を公開し直す | `gh workflow run pages-deploy.yml --ref main` |
| PR 版を作り直す | その PR へ push する |

- `pages-build.yml` の手での起動は、`--ref main` でだけ側を作る。ほかのブランチやタグで起こすと失敗する
- リリース版は、本番のリリース（`release.yml` の `dry-run=false`）の land の後に、release.yml が同じ起動を打つ。普段は手で起こさない
- リリース版は、プラグインごとの最新のタグ（プレリリースを除く）から作る。どれかのタグのコミットに `docs/junit-lanes.json` が無いと、そのタグの名前を出して止まる
- artifact は、開発版が 90 日、リリース版と PR 版が 7 日で消える。保管が終わっていれば、消えても公開は変わらない
- PR 版が「開発版の artifact が無い」で止まったら、開発版を作り直してから、その PR へ push する
- 保管の job が落ち続けて artifact が消えたら、開発版とリリース版を上の起動で作り直す。PR 版は、次の push で作り直される
- 確かめの手順は [`specs/028-pages-site/quickstart.md`](../../specs/028-pages-site/quickstart.md)

### 管理者の設定

リポの管理者が、次を設定しています。作り直すときも、この値にします。

| 対象 | 場所 | 値 |
|---|---|---|
| GitHub Pages | Settings → Pages → Build and deployment → Source | 「GitHub Actions」 |
| `pages-store` の ruleset | `.github/rulesets/pages-store.json` | 作成・更新・削除を止める。bypass は pages-store の App だけ |
| リリースのタグの ruleset | `.github/rulesets/release-tags.json` | `*-v*` の作成・更新・削除を止める。bypass は PECOT_BOT の App だけ |
| pages-store の App | org の Settings → Developer settings → GitHub Apps → `pecotcraft-pages-store` | 権限は Contents: write だけ。Webhook なし。このリポにだけ入れる |
| environment `pages-store` | Settings → Environments → `pages-store` | 変数 `PAGES_STORE_APP_CLIENT_ID` と secret `PAGES_STORE_APP_PRIVATE_KEY`。Deployment branches and tags は「Selected branches and tags」で、種類が Branch の `main` だけ |
| environment `github-pages` | Settings → Environments → `github-pages` | Deployment branches and tags は、種類が Branch の `main` だけ |

- ruleset を変えるときは、JSON を直してから次のコマンドで入れる。id は `gh api repos/pecotcraft/pecot/rulesets` で読む

  ```bash
  gh api -X PUT repos/pecotcraft/pecot/rulesets/<id> --input .github/rulesets/<名前>.json
  ```

- environment のデプロイ先の種類を Tag にしない。`main` という名前のタグが通る
- `pages-store` へ書くのは pages-store の App だけにする。リリースの App（PECOT_BOT）は main とタグにも書けるので、使わない
- App の秘密鍵を作り直したら、environment `pages-store` の secret を入れ替える。リポの secret には置かない

## 名前の語彙（`names`）

`generated.json` の最上位の `names` に、項目の名前の決まりを書きます。各プラグインの書き出し（`cli/scripts/export-interface.ts`）が、ソースの語彙から作ります。`names` は必須です。

```json
{
  "separator": " ",
  "positions": [
    [{ "word": "issue", "meaning": "Issue そのもの" }],
    [{ "word": "show", "meaning": "1 件を出す", "read_only": true }, { "word": "create", "meaning": "GitHub のものを作る" }]
  ],
  "rest": false
}
```

| 欄 | 中身 |
|---|---|
| `separator` | 名前の語の区切り。`" "` か `"_"` |
| `positions` | 語の位置ごとの一覧。語（英小文字と数字）と意味を持つ |
| `read_only` | 読むだけの語の印。`true` だけを書く |
| `rest` | `true` なら、`positions` の後ろに 1 語以上の自由な語（英小文字と数字）を求める |

`validate`（`lint-defs`）は次を止めます。

- 項目の `name` を `separator` で分けた語の数が合わない。`rest` が `false` なら `positions` の数と同じ、`true` ならそれより多い数が要る
- 語が、その位置の一覧に無い
- 同じ位置に同じ語が 2 回ある
- 名前に `read_only` の語を持つ項目の `effects` に、`read` でない種類がある（`authored.yaml` の行で出す）

`read_only` の確かめが見るのは、`positions` に載った語だけです。
`rest` の側の語（pecot-tools の操作名など）には印を付けられないので、確かめの対象になりません。
今この確かめが働くのは、`read_only` の印を持つ pecot-workflow だけです。

書き出しの `--check` は `names` も比べるので、語彙を変えて書き出しを忘れると止まります。

| プラグイン | 区切り | 語彙の置き場 |
|---|---|---|
| pecot-workflow | 空白 | `cli/src/commands/names.ts` の `COMMAND_GROUPS`・`COMMAND_VERBS`（`readOnly` が印） |
| pecot-visual | `_` | `cli/src/mcp/tool-names.ts` の `TOOL_SUBJECTS`・`TOOL_VERBS` |
| pecot-tools | `_`（3 語目からは自由な語） | `cli/src/mcp/tool-names.ts` の `TOOL_PREFIXES`・`TOOL_SERVICES` |

### 語を足すとき

1. 上の表の語彙の置き場に、語と意味を足す。読むだけの動詞なら印を付ける
2. 書き出しを作り直す: `pnpm --dir plugins/<plugin>/cli exec tsx scripts/export-interface.ts --write`
3. `pnpm exec nx run interface-spec:lint-defs` で、名前と `effects` が語彙に合うかを確かめる

既にある語の意味を変えるときは、その語を使う全部の項目が新しい意味に合うかを確かめます。
