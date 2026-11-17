---
pecot-workflow: patch
---

設定とトークンの無い clone で `pr create --prepare` が止まらず、`Closes` を空のままテンプレートを書く。
`.pecot/config/` の無い clone では `.env` を作らず、`gh auth login` と起動前の環境変数で渡す案内を出す。
