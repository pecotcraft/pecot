---
pecot-visual: patch
---

PPTX 変換の dist 配信サーバの、配信先の外を読ませない判定を、CodeQL が認める書き方へ改めた。
`//` のように配信先自身を指す要求は、index.html ではなく 404 を返す。変換結果は変わらない。
