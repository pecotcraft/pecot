<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/pecot-badge-dark.svg">
    <img src=".github/assets/pecot-badge-light.svg" alt="pecot" width="440">
  </picture>
</p>

<h3 align="center">Claude Code の課題管理を、GitHub Projects で。</h3>

<p align="center">
  AI 駆動の高速なアジャイル開発を可能にする、Claude Code 向けのエージェントプラグインです。<br>
  GitHub Projects を中心とした課題管理をサポートし、快適な開発体験を提供します。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Claude_Code-6B4FBB?style=flat-square&logo=anthropic&logoColor=white" alt="Claude Code">
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/GitHub_Projects-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub Projects">
  <img src="https://img.shields.io/badge/Spec_Kit-181717?style=flat-square&logo=github&logoColor=white" alt="Spec Kit">
</p>

## pecot でできること

現在準備中です。

## セットアップ

### システム要件

以下のソフトウェアがインストールされている必要があります。

- [Claude Code](https://claude.ai/code)
- [Node.js](https://nodejs.org/ja)
- [Git](https://git-scm.com/)
- [GitHub CLI](https://cli.github.com/)

### インストール

GitHub CLI でログインし、GitHub Projects の操作に必要な `project` スコープを追加します。

```bash
gh auth login
gh auth refresh -s project
```

pecot は、[Claude Code のプラグイン](https://code.claude.com/docs/ja/plugins)として配布しています。
次のコマンドで、このリポジトリをマーケットプレイスとして Claude Code に追加し、プラグインをインストールします。

```bash
claude plugin marketplace add https://github.com/pecotcraft/pecot.git
claude plugin install pecot-w@pecot
claude plugin install pecot-v@pecot
```

pecot-w を初めて使用するときは、作業するリポジトリで `/pecot-w:w-onboarding` を実行して、GitHub Projects のボードを作成してください。

### 更新

最新のバージョンに更新するには、次のコマンドを実行します。

```bash
claude plugin update pecot-w@pecot
claude plugin update pecot-v@pecot
```

プロジェクトスコープでインストールした場合は、`-s project` を付けて実行してください。

## ライセンス

MIT License で公開しています。詳しくは [LICENSE](LICENSE) を参照してください。
