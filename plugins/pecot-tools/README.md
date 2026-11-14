<div align="center">

# pecot-tools plugin

</div>

<!-- markdownlint-disable MD013 -->
![Claude Code](https://img.shields.io/badge/Claude_Code-2.1.141%2B-6B4FBB?style=flat-square&logo=anthropic&logoColor=white) ![GitHub Copilot CLI](https://img.shields.io/badge/Copilot_CLI-1.0.97%2B-24292F?style=flat-square&logo=githubcopilot&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-24.22.1%2B_%2F_26.12.1%2B-339933?style=flat-square&logo=node.js&logoColor=white) ![AWS CLI](https://img.shields.io/badge/AWS_CLI-v2_2.22%2B-FF9900?style=flat-square&logo=amazonwebservices&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white) ![MCP](https://img.shields.io/badge/MCP-stdio-1F1F1F?style=flat-square)
<!-- markdownlint-enable MD013 -->

許可リストで限定した awscli コマンドを MCP ツールとして提供します。

---

## MCP ツール

MCP サーバ `pecot-tools` が、`aws_<service>_<subcommand>` のツールを 26 件公開します。
ツール名は、awscli の `<service> <subcommand>` の `-` を `_` に置き換えた形です。
許可リストに無いコマンド・S3 へのアップロード方向の指定・Athena の変更系クエリは、
awscli を起動する前に拒否します。

許可リストに書くツール名は、Claude Code では `mcp__plugin_pecot-t_pecot-tools__<ツール名>` です。
GitHub Copilot CLI では `pecot-tools-<ツール名>` です。

ツールの一覧と、失敗した応答が返す `kind` の一覧は
[scripts/release/mcp-dist-README.md](scripts/release/mcp-dist-README.md) にあります。

プラグインを入れずにツールだけ使う場合は、npm のパッケージ `@pecot/tools-mcp` の README を参照してください。

---

## 動作要件

- Claude Code 2.1.141 以上、または GitHub Copilot CLI 1.0.97 以上
- Node.js 24 系は 24.22.1 以上、26 系は 26.12.1 以上（脆弱性の修正を含まない版では起動しません）
- awscli v2（2.22 以上）が PATH にあること。それ未満は `awscli-missing` で拒否する

インストール手順は[リポジトリルートの README](../../README.md) を参照してください。

---

## ライセンス

MIT License です。全文は [LICENSE](../../LICENSE) にあります。
