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

- JUnit が無くても作れる。合否は「未実行」になる
- 読む JUnit は `docs/conf.py` の `iface_junit` に並べている
- 項目の ID を書いたテスト（`verifies`）だけが、項目につながる。定義書に無い ID のケースは落とす

### CI の artifact に上げない理由

CI は affected のレーンだけを matrix の job に分けて動かすので、1 つの job に全レーンの JUnit がそろいません。
そろわない JUnit で作った HTML は、動かなかったレーンの項目を「未実行」と出し、読む人を誤らせます。
全量を集める job を足す案は、全レーンを毎回動かすことになるので採りません。
