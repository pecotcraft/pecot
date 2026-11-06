<div align="center">

# pecot-visual plugin

</div>

<!-- markdownlint-disable MD013 -->
![Claude Code](https://img.shields.io/badge/Claude_Code-2.1.141%2B-6B4FBB?style=flat-square&logo=anthropic&logoColor=white) ![GitHub Copilot CLI](https://img.shields.io/badge/Copilot_CLI-1.0.97%2B-24292F?style=flat-square&logo=githubcopilot&logoColor=white) ![Node.js](https://img.shields.io/badge/Node.js-24.22.1%2B_%2F_26.12.1%2B-339933?style=flat-square&logo=node.js&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white) ![Slidev](https://img.shields.io/badge/Slidev-3AB9D4?style=flat-square&logo=slidev&logoColor=white) ![draw.io](https://img.shields.io/badge/draw.io-F08705?style=flat-square&logo=diagrams.net&logoColor=white)
<!-- markdownlint-enable MD013 -->

図表・スライドの作成を担うスキル集です。

---

## スキル

| スキル | 内容 |
|:------|:----|
| v-drawio | draw.io ダイアグラムを生成し、ブラウザで直接開ける URL として出力する。AWS / Azure 構成図、インフォグラフィック、ポスター / 報告書などのビジュアルに対応する |
| v-slidev | Slidev プレゼンテーションの新規作成・編集・PPTX 変換。テーマ（git の URL とタグ、またはローカルのパス）を参照するスタンドアロンの Slidev プロジェクトを、任意のリポジトリで生成できる |
| v-evidence | ユーザーが提供したスクリーンショット群から、統一フォーマットの作業エビデンス xlsx を対話で生成する |

## エージェント

スキルの実行中に、次のエージェントが起動されます。

| エージェント | 役割 |
|:-----------|:----|
| v-diagram-creator | v-drawio スキルと連携して draw.io ダイアグラムを 1 つ作成する |
| v-slide-creator | 担当するスライドを 1 枚ずつ新規作成する |

## MCP ツール

MCP サーバ `pecot-visual` が、スキルの実行部として次のツールを公開します。

- スライド系: `slide_create` / `slide_sync` / `slide_lint` / `slide_convert` / `slide_dev` / `slide_page` / `slide_theme`
- ダイアグラム系: `drawio_create` / `drawio_export`
- その他: `setup` / `evidence_create`

スライドの見た目は、本体の外にあるテーマが決めます。
`slide_create` は `theme` に、テーマの指定（`git+https://<host>/<owner>/<repo>.git#<tag>` か `file:<絶対パス>`）を受けます。
`slide_theme` は、talk-dir が参照するテーマの宣言（書体・文字サイズ・PPTX の書体とリンク色・lint の規則）と、レイアウトの一覧を返します。
`slide_lint`・`slide_dev`・`slide_convert` は、そのテーマの宣言で動きます。
テーマの宣言で `pptx.linkColor` を省くと、PPTX にハイパーリンクは付きません（リンクの色でリンクの文字を見分けているため）。

許可リストに書くツール名は、Claude Code では `mcp__plugin_pecot-v_pecot-visual__<ツール名>` です。
GitHub Copilot CLI では `pecot-visual-<ツール名>` です。
ブラウザ操作用に Playwright の MCP サーバ `pecot-visual-playwright` も登録します。
ブラウザは、端末に入っている Google Chrome を使います。
Chrome が無い端末では、次のコマンドで入れます。

```bash
npx -y playwright install chrome
```

プラグインを入れずにツールだけ使う場合は、npm のパッケージ `@pecot/visual-mcp` の README を参照してください。

---

## 動作要件

- Claude Code 2.1.141 以上、または GitHub Copilot CLI 1.0.97 以上
- Node.js 24 系は 24.22.1 以上、26 系は 26.12.1 以上（脆弱性の修正を含まないバージョンでは起動しない）
- 初回の起動で依存（約 1GB）を、クライアントが MCP に渡すデータ置き場へ取得する。プラグインを入れずに使う場合の置き場と指定方法は、npm のパッケージ `@pecot/visual-mcp` の README にある
- PPTX 変換・PNG 出力に使う Chromium は、`setup` ツールで取得する。未取得のまま呼ぶと `setup` の案内が返る

インストール手順は[リポジトリルートの README](../../README.md) を参照してください。

---

## 設定

| 環境変数 | 内容 |
|:--------|:----|
| `PECOTV_AUTO_INSTALL_BROWSER` | `1` にすると、Chromium が未取得のときに `setup` の案内を返す代わりにその場で取得します |
| `PECOTV_WSL_MOUNT_ROOT` | `/etc/wsl.conf` で automount root を変えているときに、その値を設定します。ツールのパス引数に渡した Windows 形式のパス（ドライブレター形式・UNC 形式）を `/mnt/<drive>/` 配下または WSL 内の絶対パスへ変換するために使います |
| `NODE_EXTRA_CA_CERTS` | 通信を復号するプロキシの配下で、プロキシの CA 証明書を PEM ファイルのパスで渡します。対象は Node のプロセス（npm・pnpm・Playwright の取得）です。テーマを git の URL から取るときは、git 自身の CA の設定が使われます。プラグインは証明書を同梱しません |

---

## ライセンス

MIT License です。全文は [LICENSE](../../LICENSE) にあります。
