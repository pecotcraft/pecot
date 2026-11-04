<!-- mode: shared -->
**実装の引き継ぎ** — 計画の Files から独立した作業単位を分け、w-implementer を `Agent` ツールの単発 spawn で起動してください。

```
Agent tool:
  name: w-implementer-1  （計画書の名称に合わせる）
  subagent_type: w-implementer
  model: sonnet
  prompt: （計画書のタスク指示・対象ファイル・expected_output をそのまま貼る）
```

独立した作業単位ごとに w-implementer-2, -3... を並列で起動してください。
1 メッセージ内の複数 `Agent` 呼び出しで spawn する。別メッセージで順に spawn すると直列になる。

進め方:

1. 実装結果は、終わったときに通知で main へ届く。agent teams が有効で `name` を付けた起動は teammate の idle の通知で、それ以外は完了の通知で届く。追依頼・追質問は、main から名前を宛先にして `SendMessage` で送る
2. w-implementer への prompt にコミット指示を含めない（「コミットして」「commit してから返せ」等を書かない）
3. w-implementer は実装 + 該当範囲のリンター緑 + 該当範囲のテスト緑 まで完了したら、変更ファイル一覧と結果を返す
4. コミットは main の責務。並列に動くサブエージェントが同一ワークツリーへコミットすると衝突するため、コミット主体は main 一人に集約する。main は実装結果を受け取ったら main 自身でコミットする
