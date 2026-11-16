<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/pecot-wordmark-dark.svg">
    <img src=".github/assets/pecot-wordmark-light.svg" alt="pecot" width="240">
  </picture>
</h1>

<p align="center">Claude Code のためのプラグインマーケットプレイス</p>

Agent Plugins 1.0 に対応したエージェントにも、今後対応していく予定です。
以下の 3 プラグインを配布しています。

| プラグイン | 内容 |
|:----------|:----|
| [**pecot-w**](plugins/pecot-workflow/README.md) | GitHub Projects V2 と連携した開発ワークフローの自動化。Issue 起票・実装・PR・リリースの各段階をスキルとして提供し、git worktree による並行開発に対応する |
| [**pecot-v**](plugins/pecot-visual/README.md) | 図表・スライドの作成。draw.io 構成図の生成、Slidev プレゼンテーションの作成と PPTX 変換、スクリーンショットからの作業エビデンス xlsx 生成 |
| [**pecot-t**](plugins/pecot-tools/README.md) | 許可リストで限定した awscli コマンドを MCP ツールとして提供する。SSO 認証・参照系（Lambda / CloudWatch Logs / CloudWatch メトリクス / RDS / EC2 / ECR / EventBridge Scheduler）・Athena・S3 取得の 26 ツールを MCP サーバ `pecot-tools` として公開する |

スキルとエージェントの一覧は各プラグインの README に記載しています。

---

## インストール

### 前提条件

- [Claude Code](https://claude.ai/code) 2.1.141 以上
- [gh CLI](https://cli.github.com/) — `gh auth login` で認証後、`gh auth refresh -s project` を実行する。
  GitHub Projects V2 アクセス用の `project` スコープを追加する
- Node.js 24 系は 24.22.1 以上、26 系は 26.12.1 以上 — pecot-w・pecot-v・pecot-t の実行に使う。脆弱性の修正を含まないバージョンでは起動しない

### Claude Code

```bash
claude plugin marketplace add https://github.com/pecotcraft/pecot.git
claude plugin install pecot-w@pecot
claude plugin install pecot-v@pecot
claude plugin install pecot-t@pecot
```

---

## 更新

新しいバージョンを取り込むには、次のコマンドで更新してください。

### Claude Code

```bash
claude plugin update pecot-w@pecot
claude plugin update pecot-v@pecot
claude plugin update pecot-t@pecot
```

project スコープでインストールしている場合は `-s project` を付けてください。

---

## ライセンス

MIT License です。全文は [LICENSE](LICENSE) にあります。
