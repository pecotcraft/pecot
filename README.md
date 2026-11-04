<div align="center">

# pecot

</div>

<!-- markdownlint-disable MD013 -->
![Claude Code](https://img.shields.io/badge/Claude_Code-2.1.141%2B-6B4FBB?style=flat-square&logo=anthropic&logoColor=white) ![GitHub Copilot CLI](https://img.shields.io/badge/Copilot_CLI-1.0.97%2B-24292F?style=flat-square&logo=githubcopilot&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-24.22.1%2B_%2F_26.12.1%2B-339933?style=flat-square&logo=node.js&logoColor=white) ![Python](https://img.shields.io/badge/Python-3.10_to_3.14-3776AB?style=flat-square&logo=python&logoColor=white) ![GitHub Projects](https://img.shields.io/badge/GitHub_Projects_V2-181717?style=flat-square&logo=github&logoColor=white)
<!-- markdownlint-enable MD013 -->

Claude Code / GitHub Copilot CLI 向けプラグインのマーケットプレイスです。
以下の 3 プラグインを配布しています。

| プラグイン | 正式名 | 内容 | 詳細 |
|:----------|:------|:----|:----|
| **pecot-w** | pecot-workflow | GitHub Projects V2 と連携した開発ワークフローの自動化。Issue 起票・実装・PR・リリースの各段階をスキルとして提供し、マルチリポの横断管理と git worktree による並行開発に対応する | [plugins/pecot-workflow/README.md](plugins/pecot-workflow/README.md) |
| **pecot-v** | pecot-visual | 図表・スライドの作成。draw.io 構成図の生成、Slidev プレゼンテーションの作成と PPTX 変換、スクリーンショットからの作業エビデンス xlsx 生成 | [plugins/pecot-visual/README.md](plugins/pecot-visual/README.md) |
| **pecot-t** | pecot-tools | 許可リストで限定した awscli コマンドを MCP ツールとして提供する。SSO 認証・参照系（Lambda / CloudWatch Logs / CloudWatch メトリクス / RDS / EC2 / ECR / EventBridge Scheduler）・Athena・S3 取得の 26 ツールを MCP サーバ `pecot-tools` として公開する | [plugins/pecot-tools/README.md](plugins/pecot-tools/README.md) |

導入・更新・スキルの呼び出し（`/pecot-w:w-pr` など）には短い名前（pecot-w / pecot-v / pecot-t）を使います。
スキルとエージェントの一覧は各プラグインの README に記載しています。

---

## インストール

### 前提条件

- [Claude Code](https://claude.ai/code) 2.1.141 以上、または [GitHub Copilot CLI](https://github.com/github/copilot-cli) 1.0.97 以上
- [gh CLI](https://cli.github.com/) — `gh auth login` で認証後、`gh auth refresh -s project` を実行する。
  GitHub Projects V2 アクセス用の `project` スコープを追加する
- [uv](https://docs.astral.sh/uv/) — pecot-w の pecot CLI の実行に使う
- Node.js 24 系は 24.22.1 以上、26 系は 26.12.1 以上 — pecot-v・pecot-t を使う場合。脆弱性の修正を含まないバージョンでは起動しない

### Claude Code

```bash
claude plugin marketplace add https://github.com/pecotcraft/pecot.git
claude plugin install pecot-w@pecot
claude plugin install pecot-v@pecot
claude plugin install pecot-t@pecot
```

### GitHub Copilot CLI

```bash
copilot plugin marketplace add https://github.com/pecotcraft/pecot.git
copilot plugin install pecot-w@pecot
copilot plugin install pecot-v@pecot
copilot plugin install pecot-t@pecot
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

### GitHub Copilot CLI

```bash
copilot plugin update --all
```

個別に更新する場合は次のように指定してください。

```bash
copilot plugin update pecot-w@pecot
copilot plugin update pecot-v@pecot
copilot plugin update pecot-t@pecot
```

---

## ライセンス

MIT License です。全文は [LICENSE](LICENSE) にあります。
