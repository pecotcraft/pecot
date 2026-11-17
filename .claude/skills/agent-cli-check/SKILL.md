---
name: agent-cli-check
description: Claude Code・GitHub Copilot CLI のスキルの発火・フック・プラグインの読み込み・画面の表示を、子の CLI を動かして自分で確かめる手順。これらの挙動を確かめたいとき、利用者に「試してください」と頼もうとしたときに使う。
---

# Claude Code・Copilot CLI の挙動を自分で確かめる

挙動の確認を利用者に頼みません。子の CLI を起動して、出力を読んで確かめます。
利用者に頼むのは、人の資格情報が要る操作と、エージェントから見えない画面（デスクトップアプリ・IDE）だけです。

1. 最新のやり方を調べる。フラグ・出力の形式・eval の仕組みは版ごとに変わるので、毎回確かめる
   - 公式の文書を開いて読む。`--help` だけで済ませない。`--help` には、既定の権限・読み込まれる設定・出力のイベントが載っていない
   - 結果を伝えるときは、読んだ文書の URL と手元の版を添える
   - 手元の版: `claude --version`・`claude --help`、`copilot --version`・`copilot --help`
   - Claude Code の公式の文書: `https://code.claude.com/docs/llms.txt` の索引から、当たるページを開く
     - よく使うページは `headless.md`・`plugin-evals.md`・`hooks.md`
   - Copilot CLI の公式の文書: `https://docs.github.com/en/copilot/how-tos/copilot-cli` と CLI のリファレンス
     - リファレンスは `cli-command-reference`・`cli-programmatic-reference`
2. 確かめたいことに合わせて手段を選ぶ

   | 確かめたいこと | Claude Code | Copilot CLI |
   |:---|:---|:---|
   | 1 回の挙動（スキルの発火・ツールの呼び出し・フック・プラグインの読み込み） | `claude -p` と `--output-format stream-json --verbose` | `copilot -p` と `--output-format json` |
   | 発火率・回帰・プラグインの有無の差 | `claude plugin eval` | 公式の eval が無い。`copilot -p` を決めた回数だけ回し、JSONL を数える |
   | TUI にだけ出るもの（ダイアログ・ステータス行） | tmux で `claude` を起動し、`send-keys` と `capture-pane` を使う | tmux で `copilot` を起動し、同じように使う |
   | フック・MCP の詳しいログ | `--debug-file` | `--log-level debug --log-dir` |

3. 動かして読む
   - 子の作業ディレクトリは `.pecot/work/<Issue番号>/` に置く。リポの中なので、リポのスキル・フック・設定が読まれる
   - 作業中のプラグインは、どちらも `--plugin-dir plugins/<name>` で読み込む
   - 出力の JSON から、呼ばれたツール・スキルとフックのイベントを拾う。Claude Code は `tool_use` と（`--include-hook-events` で）フックのイベント、Copilot CLI は `tool.execution_start`
4. 環境構築やツールが要るとき（コマンドの不在・古い版・ログインの切れ）は、その旨と必要な操作を利用者に伝えてから進める

落としやすい点

- Claude Code の `--bare` は、フックを動かさず、OAuth のログインも読まない。フック・スキルの確認には使わない
- `-p` は許していないツールを、止まらずに拒否する。Claude Code は `--allowedTools` か `--permission-mode`、Copilot CLI は `--allow-tool` で要るものを許す
- Copilot CLI の `-p` は、作業ディレクトリのフックとリポのプラグイン設定を、`--trust-folder` を付けたときだけ読む
- `claude plugin eval` で Bash を許すと、OS のサンドボックス（bubblewrap・socat）が要る
