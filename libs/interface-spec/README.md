# interface-spec

インタフェース定義書（`plugins/*/interface/`）の形式と検証。配布しない。

## 定義書と合否の HTML

定義書の全項目と、振る舞いの項目ごとのテストと合否を 1 つの HTML に出します。`docs/` に sphinx-needs の project があります。

```bash
# 1. JUnit を出す
pnpm exec nx run-many -t test-py test-cli test-hooks --projects=pecot-workflow,pecot-tools,pecot-visual

# 2. HTML を作る（libs/interface-spec/docs/_build）
pnpm exec nx run interface-spec:docs

# 3. 開く
python3 -m http.server -d libs/interface-spec/docs/_build
```

- JUnit が無くても作れる。合否は「未実行」になる
- 読む JUnit は `docs/conf.py` の `iface_junit` に並べている
- 項目の ID を書いたテスト（`verifies`）だけが、項目につながる。定義書に無い ID のケースは落とす

### CI の artifact に上げない理由

CI は affected のレーンだけを matrix の job に分けて動かすので、1 つの job に全レーンの JUnit がそろいません。
そろわない JUnit で作った HTML は、動かなかったレーンの項目を「未実行」と出し、読む人を誤らせます。
全量を集める job を足す案は、全レーンを毎回動かすことになるので採りません。
