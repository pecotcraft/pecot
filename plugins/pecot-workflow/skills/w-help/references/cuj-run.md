# CUJ の流し方

計画の E2E の CUJ は、実装の後に main が流す。w-revise で直した後も、直したファイルを読む CUJ を main が流し直す。サブエージェントには渡さない。

## CUJ の定義

CUJ = 利用者（人またはエージェント）が製品の起点から始め、利用者が観測する結果で終わる操作フロー。
起点はスキル起動・MCP ツール呼出・実ツール発火による hook・利用者が打つ CLI コマンドのいずれか。
同じコマンドでも、利用者が成果を得るために打つなら CUJ で、実装者が変更の健全性を確かめるために打つなら CUJ ではない。
起点のコマンドに付ける `--dry-run` / `--prepare` は副作用を消す手段なので、利用者が打つ形なら起点に含む。
CUJ ごとに「誰が・起点・観測結果」の 3 要素を必須とし、いずれかを書けない項目を CUJ と呼ばない。
テストランナー実行（run-tests.sh / pytest / vitest）・ベースライン計測・健全性確認のための dry-run は CUJ にしない。
スクリプトや hook の直叩き（`echo '{}' | bash hook.sh`）も同じく CUJ にしない。
CUJ ごとに「流す先」を書く。外へ書き込む CUJ は、プロジェクトの指示にある検証用の場所を書き、指示に無ければ作業中のリポを書く。外へ書き込まない CUJ は「手元」と書く。
外へ書き込むとは、Issue・PR・ブランチ・ボード・リリースなど、リポの外から見えるものを作る・変えることを指す。

合格基準は、利用者が観測する出力・状態で書く。「出力に文字列 X が含まれる」「テストが pass する」は合格基準にしない。
合格基準の語・書式は、plan テンプレ（`cli/templates/comment/plan.md`）など配布物に実在するものだけを使う。定義の無い語は判定できない。

## 流し方

CUJ を順に流し、合格基準ごとに合否と根拠を、PR の Verified に書く。

- 変えたものが Claude Code・GitHub Copilot CLI のプラグイン（スキル・hook・MCP サーバ・エージェント）なら、作業ツリーのプラグインで流す。`--plugin-dir` に作業ツリーのプラグインの絶対パスを渡して、新しいセッションを起こす。省くと、インストール版が動く
- hook: スクリプトを直接叩かない。新しいセッションでスキルを起動し、hook の発火と出力を記録で確かめる。依頼は自然文で書く。スラッシュコマンドでは Skill ツールを経ず、`PostToolUse:Skill` が発火しない

  ```bash
  # Claude Code
  claude --plugin-dir <作業ツリーの絶対パス>/<プラグイン> -p "<自然文の依頼>" \
    --output-format stream-json --verbose --include-hook-events
  # GitHub Copilot CLI
  COPILOT_PLUGIN_DIR_ONLY=true copilot --plugin-dir <作業ツリーの絶対パス>/<プラグイン> \
    --trust-folder -p "<自然文の依頼>" --output-format json
  ```

- 子の CLI の `-p` は、承認の要る呼び出しを止まらずに拒否する。使うツールを、Claude Code は `--allowedTools=<ツール>`、GitHub Copilot CLI は `--allow-tool='<ツール>'` で許す

- EnterPlanMode / ExitPlanMode / AskUserQuestion を含む CUJ: `-p` では動かない。tmux の新しい session で対話のセッションを起こし、`send-keys` で依頼を送り、`capture-pane` で画面を読む。tmux が無ければ、手順と合格基準を利用者に示して流してもらう
- 流す先が検証用の CUJ: 検証用の clone を作業ディレクトリにして流す。プラグインの CUJ は、その clone で子の CLI を起こす
  - clone の作り方・書き込む前の確かめ・作るものの名前の形・片付けは、プロジェクトの指示に従う。指示に片付けが無ければ、作ったものを Verified に並べる
  - 子の CLI の中の MCP ツールは、clone の設定で動く。clone でプロジェクトが有効でなければ、先に `project_activate` を呼ばせる
  - 今のセッションの MCP ツールに `repo` を渡して検証用を指す形は使わない。MCP ツールはセッションのリポの設定でボードを決めるので、検証用を指すと止まる
  - Verified に、できたものの URL を載せる
- 流す先が作業中のリポの CUJ: 作業中のリポに書き込む。作ったものを Verified に並べる
