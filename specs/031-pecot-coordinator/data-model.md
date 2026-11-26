# Data Model: pecot-coordinator プラグイン

この Epic は保存するデータを持たない。ここでは、配る物と、その間の決まりを書く。

## 配る物

| 名前 | 置き場所 | 配り方 | 持つもの | 持たないもの |
|---|---|---|---|---|
| pecot-workflow（pecot-w） | `plugins/pecot-workflow/` | marketplace・claude.ai | スキル・計算の MCP（エージェントが使うツールだけ。npx で npm の版を起動する） | `bin/`・Actions だけで使うツール・GitHub の I/O（スキルが呼ぶもの） |
| pecot-visual（pecot-v） | `plugins/pecot-visual/` | marketplace・claude.ai | スキル・MCP（npx で npm の版を起動する） | `bin/` |
| pecot-tools（pecot-t） | `plugins/pecot-tools/` | marketplace・claude.ai | MCP（npx で npm の版を起動する） | `bin/` |
| pecot-coordinator（pecot-c） | `plugins/pecot-coordinator/` | marketplace・claude.ai | スキル・マニフェスト | MCP のサーバ・`bin/`・プロジェクト固有の値 |
| Actions のプロジェクト | `actions/` | `uses:` とタグ `pecot-actions/v<版>` | action・雛形・導入の手順 | スキル・MCP・AI のエージェントに入れる物 |
| workflow-core | `libs/workflow-core/` | 配らない。pecot-workflow と `actions/` に取り込む | domain・GitHub の I/O・共通の部品 | 入口（MCP・action） |

## 決まり

- pecot-w・pecot-c を使うリポは、Actions のプロジェクトを入れる。入っていなければ、w-onboarding と `workflow doctor` が案内する（FR-010）
- プロジェクト指示は、固有の値だけを持つ（[contracts/project-instruction-values.md](contracts/project-instruction-values.md)）。coordinator の判断と手順は pecot-c のスキル、スレッドの手順は pecot-w のスキル、このリポの開発の決まりはリポの CLAUDE.md が持つ（FR-001・FR-023〜FR-026）
- スレッドの GitHub の読み書きは、[contracts/github-io.md](contracts/github-io.md) の手で行う

## 処理の置き場所の移り変わり

| 処理 | 今 | 作り替えた後 |
|---|---|---|
| ボードの同期・マージの後の片付け・アラートの同期・レビューの後処理・自動処理 | pecot-workflow の CLI と MCP のツール（同じ処理の 2 つの入口） | `actions/` の action。MCP のツールから消える |
| Issue・ボード・PR・セッション・プロジェクトの設定の読み書き | pecot-workflow の CLI が GitHub を直に呼ぶ | 計算は pecot-workflow のツール、読み書きは GitHub 公式の MCP |
| 公式の MCP に手の無い操作 | pecot-workflow の CLI が GraphQL・REST を呼ぶ | `actions/` の `github-ops`。スキルが起動する |
| リモートのブランチを消す | pecot-workflow が消す | リポの「head ブランチを自動で消す」設定 |
| coordinator の判断と手順 | プロジェクト指示の文 | pecot-c のスキル |
| スレッドの手順のうち、プロジェクト指示にある文 | プロジェクト指示の文 | pecot-w のスキル |
| このリポの開発の決まり（開発環境の設定・標準とのズレ） | プロジェクト指示の文 | リポの CLAUDE.md |

## 版

- pecot-w・pecot-v・pecot-t・pecot-c は、今の形（`<名前>-v<版>`）のタグで出す
- `actions/` は `pecot-actions/v<版>` のタグで出す
- 古い雛形から新しい雛形への切り替えは、1 回の破壊的なリリースで行う（FR-029）。pecot-w のメジャーの版を上げ、`actions/` の最初の版と同じ時に出す
