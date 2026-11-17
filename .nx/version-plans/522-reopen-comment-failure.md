---
pecot-workflow: patch
---

`issue reopen` でコメントを投稿できないと、**開き直しに失敗したと読める error で止まる**不具合を修正。
`could not comment on Issue …` で止まる。空白だけの `--comment` は、開き直す前に止める。
