# サブエージェントの使い方

スキルがサブエージェントを起こすかは、Anthropic の指針で決める。委譲する条件は、このページだけに書く。

- [Building agents: When to fold subagents into your main agent loop](https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop)
- [How and when to use subagents in Claude Code](https://claude.com/blog/how-and-when-to-use-subagents-in-claude-code)

## 避ける形

- 仕事を問題の種類で分ける。受け渡しのたびに情報が落ちる
- 同じデータを触り、いつも一緒に呼ぶ専門エージェントを分けたままにする
- 小さな作業を委譲する。委譲の手間が利益を上回る

## 良い形

- 仕事をコンテキストで分ける。ほかの部分をほとんど必要とせず、短い結果を返せる単位にする
- 独立した作業を新しいコンテキストで並列に動かし、終わったら捨てる
- 会話の経緯に引きずられない、独立した検証とレビューに使う

## 委譲する条件

次のどちらかに当たる作業だけを委譲する。どちらにも当たらなければ、main が行う。

- 独立した作業が 3 つ以上ある
- 調べるのに 10 以上のファイルを読む。または main のコンテキストを圧迫する

w-revise の Step 5 の修正と、w-active のプラン承認後の実装の引き渡しは、この条件で決める。
`opus` と `sonnet` の基準（[エージェントのモデル](agent-models.md)）は、委譲した後のモデルの選び方にだけ使う。委譲するかの判断には使わない。

## スキルがサブエージェントを起こす箇所

| 箇所 | エージェント | 当たる条件 |
|---|---|---|
| w-active の Step 8、w-revise の Step 2 | w-reviewer | 独立したレビュー。計画や diff を、書いた会話の経緯に引きずられずに見る。視点は 1 体の中で分け、問題の種類でエージェントを分けない。計画を読んだ同じ w-reviewer が PR も見るので、計画の文脈を持ち、実装の会話には引きずられない |
| w-revise の Step 2・Step 6（計画に CUJ があるとき） | w-e2e-planner | 独立した検証。製品を動かして合否だけを返す |
| 実装中の技術の質問 | w-tech-advisor | 多数の文書とソースを読み、短い答えを返す調査 |
| プラン承認後の実装、w-revise の Step 5 | w-implementer | 委譲する条件に当たるときだけ起こす。当たらなければ main が実装する |
| pecot-visual の v-drawio・v-slidev の図 | v-diagram-creator | XML とスタイル参照を大量に読み書きし、返すのはファイルのパスだけ |
| pecot-visual の v-slidev のページ | なし（main が作る） | ページは目次・前後のつながり・語の統一で互いに依存する。同じレイアウトの仕様は 1 回読めば足りる。そのため 1 枚 1 体の v-slide-creator を廃止した |
