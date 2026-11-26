---
pecot-workflow: patch
---

自動レビューの雛形（review 8）は、合言葉を書いた人の権限を `permission` の admin・write で比べます。
書き込みを基にしたカスタムロールの人が `@pecotbot review` と書いても、レビューが起動します。
