---
paths:
  - ".github/workflows/publish-npm.yml"
  - "plugins/*/scripts/release/publish-mcp-dist.sh"
  - "plugins/*/scripts/release/finalize-dist.mjs"
  - ".githooks/lib/mcp-publish-common.sh"
---

# 新しい @pecot/<name>-mcp を初めて npm に出す

trusted publisher は、レジストリにあるパッケージにしか登録できない。初回だけ手元で placeholder を出す。
新しいパッケージを足す PR では、`<name>` を埋めた手順 1〜8 を PR 本文の Risks に書く。手順の正はこの rule とする。
手順の多く（login・2FA・画面の操作）は人が行う。

`<plugin>` はプラグインのディレクトリ名（例 `pecot-workflow`）、`<name>` はプラグイン名から `pecot-` を除いたもの（例 `workflow`）とする。

## 前提

- npm 11.15.0 以上（`npm trust` の要件）
- npm のアカウントの 2FA
- npm の Organization `pecot`
- `plugins/<plugin>/scripts/release/publish-mcp-dist.sh` がある
- `.github/workflows/publish-npm.yml` に、プラグイン名を足し終えている。直す箇所は、tag の正規表現・package 名の組み立て・input の description・エラー文（`MSG_BAD_TAG`）
- npm のコマンドは、すべて out-dir（またはリポの外）で打つ。リポの中で打つと、ルートの package.json の devEngines で `EBADDEVENGINES` になる。対象は `npm login`・`npm publish`・`npm trust`・`npm deprecate`・`npm view`・`npm dist-tag`

## 手順

手順 8 で out-dir を消すまで、npm のコマンドは out-dir で打つ。

1. 配布ツリーを placeholder の版で作る。

   ```bash
   bash plugins/<plugin>/scripts/release/publish-mcp-dist.sh --dry-run --version=0.0.0-placeholder.0 --out-dir="$(mktemp -d)"
   ```

   dry-run はタグの確認を飛ばし、`npm pack` までを行う。out-dir は実体のパスでリポの外にあり、空である必要がある。出力の `==> 配布ツリー:` の行のパスを使う。
   この手順は人が打つので、`/tmp` 直下に作ってよい。`.pecot/work/<Issue番号>/` は、base で打つとリポの中になって拒まれるので使えない。
2. out-dir に `cd` し、`npm login` のあと `npm publish --access public --tag placeholder` を打つ。prerelease の版は `--tag` が無いと止まる。2FA の OTP を求められる。失敗したときは、版ができていなければそのまま打ち直せる。
3. そのプラグインの version plan が main に入ったら、リリースの dry-run（`release.yml`）で案を確かめる。本番を起動する直前に、trusted publisher を登録する。

   ```bash
   npm trust github @pecot/<name>-mcp --file publish-npm.yml --repo pecotcraft/pecot --allow-publish
   ```

   npmjs.com の Settings → Trusted publishing で登録するときは、Allowed actions で npm publish を有効にする。既定は stage publish だけで、`publish-npm.yml` の `npm publish` が通らない。
   根拠は npm の文書 `https://docs.npmjs.com/trusted-publishers` にある。2026-09-03 より後に作った設定は、この既定になる。
4. 登録から 2 日以内に、そのプラグインのリリースを本番で回し、`publish-npm.yml` の publish まで成功させる（手順は w-release スキル）。
5. placeholder を非推奨にする。OTP を求められる。

   ```bash
   npm deprecate @pecot/<name>-mcp@0.0.0-placeholder.0 "placeholder"
   npm dist-tag rm @pecot/<name>-mcp placeholder
   ```

6. `npm view @pecot/<name>-mcp dist-tags` で、`latest` が本番の版を指すことを確かめる。`--tag placeholder` で初回を出すと、レジストリが `latest` も placeholder に向けることがある。本番の publish がそれを上書きしたかを見る。
7. npmjs.com のパッケージの Settings → Publishing access で、次を選ぶ。「Require two-factor authentication and disallow tokens」。trusted publisher は影響を受けない。
   既存のパッケージ（`@pecot/visual-mcp`・`@pecot/tools-mcp` など）も、この設定を済ませたか確かめる。
8. 公開が済んだら out-dir を消す。

## 失敗したとき

trusted publisher の設定は、作ってから 2 日以内に最初の publish が成功しないと失効する。失効した設定は、使えず編集できない。
`npm trust list @pecot/<name>-mcp` で ID を調べる。`npm trust revoke --id <id> @pecot/<name>-mcp` で消してから、手順 3 を打ち直す。
画面では Trusted publishing で消してから追加する。手順 3 を打ち直したら、手順 4 からやり直す（期限がまた始まる）。

手順 4 で publish だけが失敗したときは、`release.yml` を回し直さない。`gh workflow run publish-npm.yml -f tag=<tag> --ref <tag>` で起動し直す。公開済みの版は、何もせずに終わる。
