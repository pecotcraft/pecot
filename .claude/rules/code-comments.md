---
paths:
  - "**/*.sh"
  - "**/*.ts"
  - "**/*.js"
  - "**/*.mjs"
  - "**/*.py"
  - "**/*.yaml"
  - "**/*.yml"
  - "**/package.json"
  - "**/project.json"
  - "nx.json"
---

# コードと設定のコメント

何行も続く説明のコメントを書かない。経緯・背景・コードの言い直しは、Issue・PR・commit に書く。

- 残すのは、理由がコードから読めない箇所だけにする。1 か所 1〜2 行まで
- 例: override の理由と GHSA の id、その値を固定しているテストの名前、ファイル名を変えている理由
- `package.json` / `project.json` の `//...-reason` のような説明用のキーも、同じ扱いにする
- 触ったファイルに長いコメントの塊があれば、同じ変更で 1〜2 行に縮める
- README や skills の `references/*.md` の文章は対象外
