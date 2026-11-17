---
name: agent-cli-check
description: Claude Code・GitHub Copilot CLI のスキルの発火・フック・プラグインの読み込み・画面の表示を、子の CLI を動かして自分で確かめる手順。これらの挙動を確かめたいとき、利用者に「試してください」と頼もうとしたときに使う。
---

# Claude Code・Copilot CLI の挙動を自分で確かめる

挙動の確認を利用者に頼みません。子の CLI を起動して、出力を読んで確かめます。
利用者に頼むのは、人の資格情報が要る操作と、エージェントから見えない画面（デスクトップアプリ・IDE）だけです。

1. 最新のやり方を調べる。フラグ・出力の形式・eval の仕組みは版ごとに変わるので、毎回確かめる
   - 公式の文書を開いて読む。`--help` だけで済ませない。`--help` には、既定の権限・出力のイベントの全体が載っていない
   - 手元の版: `claude --version`・`claude --help`、`copilot --version`・`copilot --help`
   - Claude Code の公式の文書: `https://code.claude.com/docs/llms.txt` の索引から、当たるページを開く
     - よく使うページは `headless.md`・`plugin-evals.md`・`hooks.md`・`settings.md`
   - Copilot CLI の公式の文書: `https://docs.github.com/en/copilot/how-tos/copilot-cli` と CLI のリファレンス
     - リファレンスは `cli-command-reference`・`cli-programmatic-reference`
2. 確かめたいことに合わせて手段を選ぶ

   | 確かめたいこと | Claude Code | Copilot CLI |
   |:---|:---|:---|
   | 1 回の挙動（スキルの発火・ツールの呼び出し・フック・プラグインの読み込み） | `claude -p` と `--output-format stream-json --verbose` | `copilot -p` と `--output-format json` |
   | 発火率・回帰・プラグインの有無の差 | `claude plugin eval` | 公式の eval が無い。`copilot -p` を決めた回数だけ回し、JSONL を数える |
   | TUI にだけ出るもの（ダイアログ・ステータス行） | tmux で `claude` を起動し、`send-keys` と `capture-pane` を使う | tmux で `copilot` を起動し、同じように使う。読み込んだフック・プラグインは `/env` で見る |
   | フック・MCP の詳しいログ | `--debug-file` | `--log-level debug --log-dir` |

   - `claude plugin eval` には、プラグインの下の `evals/` にケースが要る。このリポのプラグインには無いので、`claude plugin eval init` で作り、確かめた後に消す
3. 動かして読む
   - 子の作業ディレクトリは、確かめたい変更がある worktree のルートにする
     - Claude Code は `.claude/settings.json` を作業ディレクトリからだけ読む。親をたどって読むのはスキルと CLAUDE.md だけ
     - `.pecot/work` は base へのリンクなので、その下で起動すると worktree の変更ではなく base を読む
     - 子の出力の保存先だけを `.pecot/work/<Issue番号>/` にする
   - 作業中のプラグインは、どちらも `--plugin-dir <worktree の絶対パス>/plugins/<name>` で読み込む。相対パスは子の作業ディレクトリから解かれる
   - 出力の JSON で見るもの

     | 見るもの | Claude Code（stream-json） | Copilot CLI（JSONL） |
     |:---|:---|:---|
     | プラグインの読み込み | `system/init` の `plugins`・`plugin_errors`。同名のインストール済みプラグインと入れ替わるので、`plugins[].path` が `--plugin-dir` の先かを見る | `/env`（TUI） |
     | ツール・スキルの呼び出し | `tool_use` | `tool.execution_start`（スキルは `skill` ツール） |
     | フック | `--include-hook-events` で出るフックのイベント | `hook.start`・`hook.end` |

     - Copilot CLI のイベントの名前は公式の文書に無く、SDK の型定義にだけある。名前は出力で確かめる
4. 結果を伝える。読んだ公式の文書の URL と、子の CLI の版を添える
5. 環境構築やツールが要るとき（コマンドの不在・古い版・ログインの切れ）は、その旨と必要な操作を利用者に伝えてから進める

落としやすい点

- Claude Code の `--bare` は、フックを動かさず、OAuth のログインも読まない。フック・スキルの確認には使わない
- `-p` は、承認が要る呼び出しを止まらずに拒否する。Claude Code では、拒否が stream-json の `permission_denied` に出る
  - 要るものを許すには、Claude Code は `--allowedTools` か `--permission-mode`、Copilot CLI は `--allow-tool` を使う
  - Claude Code の `--permission-mode auto` では、`--allowedTools` に書いた素の `Bash` が捨てられる
- Copilot CLI の `-p` は、作業ディレクトリが信頼済みでなければ、フック・ワークスペースの MCP・リポのプラグイン設定を読まない
  - 1 回だけ信頼するには `--trust-folder` を付ける。信頼は親のディレクトリに及ばないので、作業ディレクトリはリポのルートにする
- `claude plugin eval` で Bash を許すと、OS のサンドボックス（bubblewrap・socat）が要る
