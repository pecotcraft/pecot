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
- `devcontainer-image.yml` の PR の run は build だけの job で動き、`packages: write` を持たない。push は手での起動・main への push・schedule の job が行う
- `Dockerfile` のベースイメージは tag と digest で固定する。digest の更新は dependabot（`docker`）の PR で見る
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

## pages-store の取得

- 公開サイトの保管ブランチ `pages-store` は大きく、開発では読まない
- 起動のたびに `post-start.sh` が `exclude-pages-store.sh` を呼び、`git fetch` の対象から外す
  - 取得の設定（`remote.origin.fetch`）に `^refs/heads/pages-store` を足し、残っている `origin/pages-store` を消す
  - 負の refspec で外したブランチの追跡 ref は、`git fetch --prune` では消えない
- 中身を読みたいときは、手元の clone で `git fetch origin pages-store` しない。`origin/pages-store` が作り直され、展開で数百 MB の中身が手元の pack に入る。`--depth` を付けると、手元の clone が浅い clone にも変わる
- 別のディレクトリへ、1 本だけ浅く取る

  ```bash
  git clone --depth 1 --single-branch --branch pages-store \
    https://github.com/pecotcraft/pecot.git .pecot/work/<Issue番号>/pages-store
  ```
