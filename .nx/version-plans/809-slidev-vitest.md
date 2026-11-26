---
pecot-visual: patch
---

Slidev の lint のテストを vitest に移し、使わなくなった c8 を devDependencies から外した。
runtime-lock.yaml から、使われなくなった @typescript-eslint の古い版を外した。動作は変わらない。
