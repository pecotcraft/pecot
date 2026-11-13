# エージェントのモデル

スキルが起こすエージェントのモデルは、役で決まるものはエージェントの定義に書き、作業の中身で決まるものは計画に書く。
main のモデルをそのまま引き継がせない。main が最上位のモデルでも、エージェントは作業に見合うモデルで動く。

## 役ごとのモデル

| 役 | エージェント | モデル | 決める場所 |
|---|---|---|---|
| 計画と PR の技術レビュー | w-tech-advisor | `opus` | 定義の `model` |
| CUJ のレビューと実行 | w-e2e-planner | `opus` | 定義の `model` |
| 実装 | w-implementer | 作業単位ごとに `sonnet` か `opus` | 計画の Files の作業単位の表。計画に無いときは定義の `sonnet` |
| w-revise の Step 2 のコード品質のレビュー | w-implementer | `sonnet` | 定義の `model` |
| w-revise の Step 5 の修正 | w-implementer | 群ごとに `sonnet` か `opus` | Step 5 の割り当て表 |

- レビューの 2 体は、公式文書とソースを読んで判断する役なので `sonnet` には下げない。スキルの本文で `Agent` の `model` を上書きしない
- w-revise のコード品質のレビューは、差分のバグ・重複・読みやすさを見る作業で、公式文書を調べる判断は要らない。そのため定義の `sonnet` のままにする（意図した例外）

## 実装者のモデルの基準

作業単位の中身で選ぶ。ファイルの数や行数では決めない。難しさは量と比例しない。

- `opus`: 次のどれかを含む単位
  - 新しいロジック
  - 既存の振る舞いを変える分岐
  - 複数のモジュールにまたがる変更
  - 不具合の原因の特定
- `sonnet`: 次だけの単位
  - 決まった形の置き換え
  - 雛形と文書の更新
  - 既存の形にならうテストの追加

選んだモデルは、`Agent` ツールの `model` に渡す。

### `fable` に上げるとき

最上位のモデル（`fable`）は最初から選ばない。
`opus` の実装者が、最初の実装の後に同じ単位で 2 回直しても通らないときだけ、その単位を `fable` に上げる。
`fable` を使えない契約・設定なら、上げずにユーザーの判断を仰ぐ。

- `availableModels` が `fable` を許さないとき、`model: fable` はエラーにならず別のモデルで動く。main は気づけない
- プランによっては、Fable は usage credits に課金される
- 上げる前に、ユーザーの同意を取る
- 起こした後は、置き換えの警告が出ていないかで、`fable` で動いていることを確かめる
- 計画の作業単位の表と w-revise の割り当て表には、最初に選んだモデルを書く。`fable` に上げたら、その行のモデルを `fable` に書き換える

## Claude Code で指定どおりにならない条件

モデルは、呼び出しの `model` 引数 → 定義の `model` → 環境変数 `CLAUDE_CODE_SUBAGENT_MODEL` → main のモデルの順で決まる。次のときは、指定と違うモデルで動く。

- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` のとき（v2.1.257 以降）。定義と呼び出しの `model` を無視する。全員が、`CLAUDE_CODE_SUBAGENT_MODEL` があればそのモデル、無ければ main のモデルで動く
- 組織の `availableModels` が指定のモデルを許さないとき。許された中で同じ系統の最新版か、main のモデルに置き換わる。エラーにはならず、警告が出る
- 提供元によっては、別名が古い版を指すことがある。該当は次のとおり。
  - Claude Platform on AWS（`sonnet`）
  - Amazon Bedrock（`sonnet`）
  - Google Cloud's Agent Platform（`sonnet`）
  - Microsoft Foundry（`opus` と `sonnet`）
- 版を固定するときは `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` を設定する

補足

- main が同じ系統（Opus）のとき、別名 `opus` は main と同じ版になる
- mod の `agent.spawn` フックがモデルを決めると、呼び出しの引数より優先する

## GitHub Copilot CLI

GitHub Copilot CLI（1.0.22 以降）は、同じ定義の `model` と、task ツールの `model` を読む。
次のときは、定義の `model` に従わず、セッションのモデルで起きる。

- モデルの選択が auto のとき
- 使えるモデルに無い名前のとき
- セッションのモデルより費用の倍率が高く、上限を超えるとき

ただし 1.0.110 の auto では、サブエージェントの呼び出しは `400 model_not_supported` で失敗しうる。定義を `inherit` にしても同じになる。

Copilot CLI では、このページのモデルを下限として保証できない。
Copilot CLI も 1.0.64 から、`opus`・`sonnet` を別名として受け付ける。ただし、定義と task ツールの `model` で解決されるかは確かめられておらず、auto ではセッションのモデルになる。
そのため、Copilot CLI で実装者を起こすときは `model` を省くか、Copilot のモデル名を渡す。
エージェントを決まったモデルで動かしたいときは、`/subagents` でエージェントごとにモデルを選ぶ。
