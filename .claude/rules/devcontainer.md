---
paths:
  - ".devcontainer/**"
  - ".githooks/ci/dev-container.sh"
  - ".github/workflows/devcontainer-image.yml"
  - "plugins/pecot-visual/cli/src/node-runtime.ts"
  - "plugins/pecot-tools/cli/tests/**"
---

# devcontainer の版とイメージ

## CI 用のイメージ

- tag は `def-<key>` と、main だけの `latest`。`<key>` は `.githooks/ci/dev-container.sh tag` が出す
  - `<key>` は、イメージに入るファイル（`Dockerfile`・`devcontainer.json`・`devcontainer-lock.json`・`features/`）の hash
- tag が無いと、CI の job ごとに build して 1 本 5〜29 分かかる。これらのファイルを変える PR は、merge queue の前に `gh workflow run devcontainer-image.yml --ref <ブランチ>` で tag を載せる。main 以外の ref は既存の tag を上書きしない
- devcontainer CLI の版は `dev-container.sh` の 1 か所で、dependabot は追わない。手で上げる

## awscli（2.39.4）

- `plugins/pecot-tools` の実 awscli テスト（`cli/tests/integration/real-awscli.test.ts`）はこの版で動く
- 偽 awscli の fixture は 2.36.40 から採った（`grep -rn 2.36.40 plugins/pecot-tools`）
- 版を上げるときは、この見出しの版と `devcontainer.json` の `aws-cli` feature の `version` を一緒に直す。直したら実 awscli テストを動かす
- 落ちたら `cli/src/domain`・`cli/src/infra` を直し、fixture を新しい版から採り直す
  - 採り方は `cli/tests/_fixtures/fake-aws/fixtures/README.md` の「採取手順」
- SSO のデバイス認証（`aws sso login --no-browser --use-device-code`）はテストの対象外。SSO 認証できる端末を使い、手で確かめる

## Node.js

- pecot-visual / pecot-tools は脆弱性修正版より古い Node.js では起動しない。下限は `plugins/pecot-visual/cli/src/node-runtime.ts` の表で、devcontainer も同じ版に固定する
- 下限を上げるときは、次の 2 つを同じ変更で直す
  - `grep -rn <旧下限> plugins .githooks .github` で当たる箇所
  - `devcontainer.json` の `node` feature の `version`
- 更新前から動いている Claude Code・MCP サーバ・端末は古い Node.js のままなので開き直す

## Claude Code

- `.devcontainer/Dockerfile` でネイティブ版を vscode ユーザーの持ち物で入れ、自動更新で最新に保つ
- `npm install -g` や feature で入れ直さない。root の持ち物になり、自動更新が止まる
