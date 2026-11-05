---
text-rules: patch
---

`scripts/ready.mjs` は、root フックが dist を使えるかを判定する。CodeQL が構文エラーとして解析から外していたので、読める書き方へ改めた。判定の結果は変わらない。
