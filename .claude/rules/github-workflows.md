---
paths:
  - ".github/workflows/*.yml"
---

# GitHub Actions の workflow の step 名

step 名は英語で、Actions でよく使う形にする。Actions の画面と `gh run view` に出るので、何をする step かが名前だけで分かるようにする。

- 動詞で始める命令形にし、先頭だけ大文字にする。例: `Checkout`・`Set up Node.js`・`Install dependencies`・`Run checks`・`Upload logs`
- `uses:` だけの step にも `name:` を付ける。公式の Action は、その Action の README の呼び方に合わせる（`Checkout`・`Set up uv`・`Log in to GHCR`）
- 失敗の切り分けに使う step は、名前で区別できるようにする。例: 基盤の失敗は `Start dev container`、テストの失敗は `Run checks` に出る
- 必須チェックは `ci-result` で、ruleset が参照するので job 名を変えない。`checks` は matrix で、チェックの名前は `checks (<part>)` になる
- tests は動的な matrix で、チェックの名前は `tests (<project>:<target>)` になる（例: `tests (pecot-visual:test-cli)`）。
  レーンの一覧は `lanes` の job が nx の task graph から作る
