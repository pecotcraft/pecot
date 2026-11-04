# Contract: 公開後の導入手順

公開したリポ `pecotcraft/pecot` の README と、npm のパッケージの README が案内する手順。SC-004・SC-005 の判定は、この手順だけを見て行う。

## 前提として案内するもの

| ソフトウェア | 要るとき | 認証 |
|---|---|---|
| Claude Code | プラグインを使うとき | GitHub の認証は要らない |
| gh CLI | pecot-w でボードを操作するとき | `gh auth login` と `gh auth refresh -s project` |
| uv | pecot-w の CLI を動かすとき | 要らない |
| Node.js（24 系は 24.22.1 以上、26 系は 26.12.1 以上） | pecot-v・pecot-t と、MCP の単体配布を使うとき | 要らない |

## プラグインの導入

Claude Code:

```bash
claude plugin marketplace add https://github.com/pecotcraft/pecot.git
claude plugin install pecot-w@pecot
claude plugin install pecot-v@pecot
claude plugin install pecot-t@pecot
```

## MCP の単体配布

```json
{
  "mcpServers": {
    "pecot-tools": {
      "command": "npx",
      "args": ["-y", "@pecot/tools-mcp"]
    }
  }
}
```

- pecot-visual は `@pecot/visual-mcp` を指す同じ形にする
- 版を固定するときは `@pecot/tools-mcp@1.2.3` のように版を付ける
- 依存は `npm-shrinkwrap.json` で固定されているため、同じ版なら同じ依存が入る
- Windows の MCP クライアントからは、WSL2 経由の `wsl` を `command` にする形を今と同じく案内する

## 通信を復号するプロキシの配下で使うとき

プロキシの CA 証明書を、Node の環境変数 `NODE_EXTRA_CA_CERTS` に PEM ファイルのパスで渡す。pecot は証明書を同梱しない。

## 置き換わる記述

| 今の README の記述 | 公開後 |
|---|---|
| `https://github.com/aistcraft/aist-plugin.git` | `https://github.com/pecotcraft/pecot.git` |
| `aist-w@aistcraft` などのプラグイン名 | `pecot-w@pecot` など |
| `git+https://github.com/aistcraft/aist-*-mcp.git` | `@pecot/*-mcp` |
| 配布元ホストへの git 認証の前提 | 削除する |
| `#v<version>` による版の固定 | `@<version>` による版の固定 |
