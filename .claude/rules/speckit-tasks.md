---
paths:
  - "specs/**/tasks.md"
---

# speckit の tasks.md を扱う前に

`specs/NNN-*/tasks.md` は計画の記録です。各フェーズは `/pecot-w:w-issueize` で Epic の sub-issue にします。

- 進捗は Epic の sub-issue で管理する。tasks.md のチェックボックスは進捗を表さない
- 実装の PR で、tasks.md のチェックボックスを `[x]` にしない
- 実装は `/pecot-w:w-active` で Issue から始める。`/speckit-implement` は tasks.md に `[X]` を付けるので使わない
- フェーズの進み具合は、tasks.md ではなく Epic の sub-issue で調べる
