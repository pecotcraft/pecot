---
pecot-workflow: patch
---

`pecot release merge` は、`--repo` が今の Git remote から外れていれば終了コード 1 で止まる。
`--repo` を使わないコマンドに短い形 `N` を渡したときの error は、フル形式だけを案内する。
