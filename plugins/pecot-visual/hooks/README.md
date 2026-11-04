# pecotv で使えるリソース

スライド作成（v-slidev）・図表作成（v-drawio）で指定できるリソースの一覧。
このファイルはプラグイン更新時に自動上書きされる。

## スライドレイアウト（v-slidev）

レイアウトの一覧は本体に同梱しない。talk-dir が参照するテーマの宣言（`pecot-theme.json`）が持つ。
名前・用途・使える状態は MCP ツール `slide_theme` の応答で得る。

## 図表スタイル（v-drawio）

| スタイル | 用途 |
|---------|------|
| `aws` | AWS 構成図（VPC / Subnet / AWS リソースアイコン） |
| `azure` | Azure 構成図（VNet / Resource Group / Azure アイコン） |
| `infographic/ja` | スライドに置く日本語ラベルの説明図（Vercel の作法に汎用の配色） |
| `infographic/en` | スライドに置く英語ラベルの説明図（Vercel の作法に汎用の配色） |
| `poster/general` | 日本語ポスター・年次報告書。レイアウト指定のない一枚絵に使う |
| `poster/swimlane-flow` | スイムレーン形式の処理フロー図（工程列 × 役割レーン） |

`poster/` 配下はレイアウトごとに分かれており、どれか 1 つだけが使われる。
スイムレーンのようにレイアウトが定まっているならそのレイアウトを、決まっていなければ `poster/general` を指定する。

依頼例: 「triad-triptych でまとめスライドを作って」「azure スタイルで構成図を描いて」「poster/swimlane-flow で発注承認の処理フローを描いて」
