# drawio-icons

v-drawio の `icon://<分類>/<名前>` が指すアイコンの置き場です。

- 取得元: Lucide のリリース `1.66.0` の `icons/*.svg`（`https://github.com/lucide-icons/lucide`）
- ライセンス: ISC（同じ階層の `LICENSE`）
- 分類: Lucide の `icons/<名前>.json` の `categories` の先頭。`$extends:` は継承元の分類に解決する。分類が複数ある名前は先頭の分類にだけ置く
- 線画の SVG（`stroke="currentColor"`）。`icon://...#<色>` の色指定で線の色が替わる
- 版を上げるときは、全件を入れ直す（旧版の名前が消えるため、参照元の `icon://` も直す）
