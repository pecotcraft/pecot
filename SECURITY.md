# セキュリティポリシー

pecot（pecot-w / pecot-v / pecot-t）の脆弱性を見つけたときの報告先と、報告の対象と、修正するバージョンを示します。

## 報告の方法

GitHub の非公開の脆弱性報告で受け付けます。[Report a vulnerability](https://github.com/pecotcraft/pecot/security/advisories/new)（リポジトリの Security タブ）から送ってください。本文に次を書いてください。

- 影響するプラグインとバージョン（`claude plugin list` / `copilot plugin list` で分かる）
- 再現手順と、何が起きるか（例: 許可リスト外のコマンドが実行できる、認証情報がログに出る）

公開 Issue は誰でも読めるので、脆弱性は Issue に書かないでください。
また、トークン・パスワード・鍵などの認証情報は、漏えいの報告であっても値そのものを本文に書かないでください。
どこにあるか（ファイルパス・コミット・ログの場所）だけを書いてください。

## 対象

- 3 プラグインのコード（スキル・hooks・CLI・MCP サーバ）
- npm のパッケージ `@pecot/visual-mcp` / `@pecot/tools-mcp` / `@pecot/workflow-mcp` の配布物
- 依存ライブラリの脆弱性は、このプラグインの使い方で悪用できる場合に、advisory の URL を添えて報告する
- Claude Code / GitHub Copilot CLI 本体や、awscli などの外部ツール本体の脆弱性は対象外。それぞれの提供元に報告する

## サポート対象のバージョン

各プラグインの最新リリースだけが修正の対象です。修正は main に入り、次のリリースで配布されます。
更新の手順は [README の「更新」](README.md#更新) を参照してください。
最新リリースは [Releases](https://github.com/pecotcraft/pecot/releases) で確認できます。
タグは pecot-w が `pecot-workflow-v*`、pecot-v が `pecot-visual-v*`、pecot-t が `pecot-tools-v*` です。
