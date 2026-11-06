---
pecot-workflow: patch
---

security alert の Tracker の題を `[Tracker] security alert — <立てた日>` にする。
本文は、判断の要る open の alert を種類ごとの見出しと表に分けた一覧だけにし、直った alert の行は消す。
例外の見直しの条件は Tracker に出さず、`pecot release preflight` が表示する。
