---
pecot-visual: patch
---

Slidev の実行に使う依存の picomatch（4.0.7 以下）に、修正版の無い advisory GHSA-fc5q-39xc-vjpf があります。
glob のパターンを外から渡せるときの ReDoS で、pecot-visual ではパターンがデッキと設定のファイルからだけ来るため、リリース監査の例外にしました。
修正版が出たら、依存を上げて例外を外します。
