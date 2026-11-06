---
pecot-workflow: patch
---

security alert の Tracker の題を `[Tracker] security alert — <立てた日>` にする。
Tracker の本文は、判断の要る open の alert の表だけにする。表は 4 列で、直った alert の行は消える。
例外の見直しの条件は Tracker に出さず、`pecot release preflight` が表示する。
