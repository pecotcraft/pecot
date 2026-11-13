---
paths:
  - ".github/workflows/publish-npm.yml"
  - "plugins/*/scripts/release/publish-mcp-dist.sh"
  - ".githooks/lib/mcp-publish-common.sh"
---

# 新しい @pecot/<name>-mcp を初めて npm に出す

trusted publisher は、レジストリにあるパッケージにしか登録できない。初回だけ手元で placeholder を出す。
新しいパッケージを足す PR では、この手順を `<name>` を埋めて PR 本文の Risks に書く。手順の多く（login・2FA・画面の操作）は人が行う。

## 前提

- npm 11.15.0 以上（`npm trust` の要件）
- npm のアカウントの 2FA
- npm の Organization `pecot`
- `.github/workflows/publish-npm.yml` の tag の正規表現と package 名の組み立てに、プラグイン名を足し終えていること

## 手順

1. 配布ツリーを placeholder の版で作る。

   ```bash
   plugins/<plugin>/scripts/release/publish-mcp-dist.sh --dry-run --version=0.0.0-placeholder.0 --out-dir="$(mktemp -d)"
   ```

   dry-run はタグの確認を飛ばし、`npm pack` までを行う。out-dir は実体のパスでリポの外にあり、空である必要がある。出力の `==> 配布ツリー:` の行のパスを使う。
2. `npm login` のあと、out-dir に `cd` してから `npm publish --access public --tag placeholder` を打つ。リポの中で打つと、ルートの package.json の devEngines で EBADDEVENGINES になる。prerelease の版は `--tag` が無いと止まる。
3. そのプラグインの version plan が main に入り、リリースを回せる状態になってから、trusted publisher を登録する。

   ```bash
   npm trust github @pecot/<name>-mcp --file publish-npm.yml --repo pecotcraft/pecot --allow-publish
   ```

   npmjs.com の Settings → Trusted publishing で登録するときは、Allowed actions で npm publish を有効にする。既定は stage publish だけで、`publish-npm.yml` の `npm publish` が通らない。
4. 登録から 2 日以内に、そのプラグインのリリースを本番で回し、`publish-npm.yml` の publish まで成功させる（手順は w-release スキル）。
5. placeholder を非推奨にする。

   ```bash
   npm deprecate @pecot/<name>-mcp@0.0.0-placeholder.0 "placeholder"
   ```

6. `npm view @pecot/<name>-mcp dist-tags` で、`latest` が本番の版を指すことを確かめる。
7. Settings → Publishing access を「Require two-factor authentication and disallow tokens」にする。trusted publisher は影響を受けない。
8. 公開が済んだら out-dir を消す。

## 失敗したとき

trusted publisher の設定は、作ってから 2 日以内に最初の publish が成功しないと失効する。失効した設定は、使えず編集できない。
`npm trust list @pecot/<name>-mcp` で ID を調べる。`npm trust revoke --id <id> @pecot/<name>-mcp` で消してから、手順 3 を打ち直す。
画面では Trusted publishing で消してから追加する。
