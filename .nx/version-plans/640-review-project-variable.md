---
pecot-workflow: minor
---

自動レビューの雛形を `review 4` に上げ、変数 `PECOT_REVIEW_PROJECT` でプロジェクトの設定を指定できるようにしました。
リポが 2 つ以上の設定に入っているときに置くと、w-review がその設定で動きます。
`pecot workflow install review --force` で入れ直してください。
