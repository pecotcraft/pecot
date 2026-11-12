# Quickstart: pecot-workflow の TypeScript 化と MCP 化の確かめ方

## 前提

- `pecotcraft/pecot` の worktree。Node `^24.22.1 || >=26.12.1`、pnpm、git、gh、jq
- フェーズ 12 より前は、golden の点検と記録に uv と Python 3.10 以上も要る。流す前に `plugins/pecot-workflow/cli/` で `uv sync` を実行する
- CUJ 1 を確かめる端末には Python と uv を入れない。作り方は「Python と uv の無い環境」にある

パスの書き方は、フェーズ 12 より前の `cli-node/` を主にする。フェーズ 12 の後は `cli-node/` を `cli/` に読み替える。

## lint とテスト

```bash
npx nx run pecot-workflow:lint
npx nx run pecot-workflow:test-cli
npx nx run pecot-workflow:test-hooks
npx nx run pecot-workflow:test-skills
# フェーズ 12 より前だけ
npx nx run pecot-workflow:test-py
```

期待: 全部通る。`test-cli` の行カバレッジが `baseline.json` の 91.0 以上。

## 前後比較

```bash
# フェーズ 12 より前だけ。今の Python と golden の差（Python を変える PR で使う）
pnpm -C plugins/pecot-workflow --filter @pecot/pecot-workflow-cli run record:parity:check
# フェーズ 12 より前だけ。差の出たシナリオだけ記録し直す
pnpm -C plugins/pecot-workflow --filter @pecot/pecot-workflow-cli run record:parity <id>...
```

期待: `record:parity:check` の差が 0。`test-cli` の `parity.test.ts` で、次の 2 つが全部一致する（SC-004）。

- Node の直接起動は、全件（228 件以上）
- MCP 経由は、MCP に写せるシナリオの全件（165 件以上）。除く 3 種と写し方は [contracts/parity.md](./contracts/parity.md)

フェーズ 12 の後は `record:parity*` が無い。`parity.test.ts` が golden を Node の回帰テストの期待値として使う。

### Python を変える PR

移行の途中で Python のコマンドや依存を変える PR は、次の順で進める。

1. Python を直す
2. 定義書を書き出し直す
3. `--check` が、差のある ID と欄を出して失敗する
4. Node のコマンド定義を直す
5. `record:parity <id>` で、出力が変わるシナリオの golden を記録し直す
6. `parity.test.ts` を通す

Python のコマンドを足して Node への足し忘れを止めるのは、フェーズ 6 の registry のテストになる。それより前は止まらない。

## 定義書との一致

```bash
# Node に登録したコマンドの surfaces.mcp 以外の欄を、定義書と比べる（test-cli の中でも流れる）
pnpm -C plugins/pecot-workflow --filter @pecot/pecot-workflow-cli exec tsx scripts/export-interface.ts --check
# 定義書の項目とテストのつなぎ、実装との食い違い
npx nx run interface-spec:lint-defs
# 切り替えの PR で、差分が surfaces.mcp だけであること
diff <(git show origin/main:plugins/pecot-workflow/interface/generated.json | jq -S 'del(.entries[].surfaces.mcp)') <(jq -S 'del(.entries[].surfaces.mcp)' plugins/pecot-workflow/interface/generated.json)
# フェーズ 12 の PR で、着手の時点から項目の ID と文が変わっていないこと
git diff -U0 <着手の時点のコミット> -- plugins/pecot-workflow/interface/authored.yaml | grep -E '^[-+] *(- id:|id:|statement:)'
# 定義書と合否の HTML を手元で作る（手順は libs/interface-spec/README.md）
npx nx run interface-spec:docs
```

期待:

- `--check` の差が 0 件（SC-010）
- `lint-defs` に `has no test` の行が無い（SC-011）
- 3 つ目の `diff` は出力が空。切り替えの前は、比べる相手との差が無い
- 4 つ目の `grep` は何も出さない（FR-022）

形式は [contracts/interface.md](./contracts/interface.md)。

## CUJ

クライアントの列に書いたものだけを実行する。SC-001 の合格は、この列のとおりに全部通ること。

| # | 誰が | クライアント | 起点と手順 | 合格基準 | 実行できる時期 |
|---|---|---|---|---|---|
| 1 | 人 | Claude Code | Python と uv の無い環境で `claude --plugin-dir plugins/pecot-workflow` を起動し、「ボードの状態を見せて」と頼む | データ置き場の `runtime/` にミラーがあり、記録に `project_info` の呼び出しと結果がある（SC-001） | フェーズ 11 の PR の中 |
| 2 | 人 | Copilot CLI | 対象の Epic を決め、`/pecot-w:w-breakdown` を実行する。specify の手前（Epic を読んだところ）で止める | `project_info` と `issue_read` が呼ばれ、データ置き場が見つからずに止まることがない（SC-002） | フェーズ 11 の PR の中 |
| 3 | 人 | 両方 | 検証用のリポで、スラッシュコマンドの外から、エージェントに `issue_create` を呼ばせる。確認の画面で拒否する | 確認の画面に `pecot-issue-create-ask` の理由が出る。文は `mcp_guidance_post_ask_issue`（MCP の入力名で書いた版。[contracts/hooks-guard.md](./contracts/hooks-guard.md)） | フェーズ 11 の PR の中 |
| 4 | エージェント | 両方 | エージェントに Bash で `pecot issue read owner/repo/1` を実行させる | deny され、`issue_read` を使うよう返る | フェーズ 11 の PR の中 |
| 5 | 人 | 両方 | Claude Code は `! pecot project info`、Copilot CLI は端末で直接 `pecot project info` を打つ | 結果が出る（deny されない） | フェーズ 11 の PR の中 |
| 6 | 人 | Claude Code | 今のリリース版で `pecot project info` を 1 回流して `venv/` を作る。同じデータ置き場のまま、`--plugin-dir` で切り替えの版を起動する | `venv/` が消え、ボードの設定とセッション状態はそのまま読める | `--plugin-dir` での確認はフェーズ 11 の PR の中、実際の更新はリリースの後 |
| 7 | エージェント | 両方 | `worktree_link` を `force` なしで呼ぶ。上書き先に実ファイルがある | 上書きされずに中止する。実ファイルが残り、入力の終端と同じ結果になる | フェーズ 11 の PR の中 |
| 8 | 人 | 両方 | プラグインを入れていない MCP クライアントに、1 エントリだけ登録する。リリースの前は、dry-run の配布ツリーを `npm pack` した tgz を `npx -y --prefix=/ --package=<tgz の絶対パス> pecot-workflow-mcp` で起動する（ディレクトリを渡すと依存が入らず起動しない）。npm に出た後は `npx -y --prefix=/ --package=@pecot/workflow-mcp pecot-workflow-mcp` | 34 個のツールが見え、`project_info` が結果を返す（SC-008） | 配布ツリーはフェーズ 13 の PR の中、npm に出た後の確認はリリースの後 |
| 9 | エージェント | 両方 | 時間のかかるツール（`release_preflight`）を MCP で呼ぶ | タイムアウトせず、同じ引数の `pecot release preflight` と、標準出力・標準エラー・終了コードが一致する（標準出力が空なら、結果のブロックは標準エラーだけになる） | フェーズ 11 の PR の中 |
| 10 | 人 | 両方 | `/pecot-w:w-quick` などでプランモードに入り、承認前に計画を Issue のコメントへ投稿してから、プランを承認する。計画が変われば `issue_comment` を打ち直す | 承認後の案内が `issue_comment` を指し、投稿と打ち直しが deny されない。計画が Issue のコメントに出る | フェーズ 11 の PR の中 |

次の CUJ は、フェーズ 11 で `bin/pecot` と `.mcp.json` が切り替わった後に確かめる。

- CUJ 1〜5
- CUJ 7、9、10

## 走査

```bash
# スキル・agents・templates の、Bash で pecot を呼ばせる記述の数（SC-003。残してよい箇所は tests/skills/tool-names.test.ts の一覧）
git grep -ohE '\bpecot"? +(issue|pr|project|session|worktree|release|security|dependabot|add-to-project|update-issue-status|create-branch|delete-branch)\b' -- 'plugins/pecot-workflow/skills/**' 'plugins/pecot-workflow/agents/**' 'plugins/pecot-workflow/hooks/templates/**' | wc -l
# 同じ式で、どのファイルに残るか
git grep -nE '\bpecot"? +(issue|pr|project|session|worktree|release|security|dependabot|add-to-project|update-issue-status|create-branch|delete-branch)\b' -- 'plugins/pecot-workflow/skills/**' 'plugins/pecot-workflow/agents/**' 'plugins/pecot-workflow/hooks/templates/**'
# hooks に、Bash の pecot の文字列で許可・確認を決める判定が残っていないこと（US3。フェーズ 11 の後）
git grep -nE 'PECOT_(PR|ISSUE)_(CREATE|SKIP)_PATTERN|_PECOT=' -- 'plugins/pecot-workflow/hooks/*.sh' 'plugins/pecot-workflow/hooks/lib/**/*.sh'
# Python の残り（SC-006。フェーズ 12 の後）
git ls-files 'plugins/pecot-workflow/**/*.py' 'plugins/pecot-workflow/**/pyproject.toml' 'plugins/pecot-workflow/**/uv.lock'
# cli-node の参照（フェーズ 12 の後。specs/ と CHANGELOG を除く）
git grep -n 'cli-node' -- . ':!specs' ':!**/CHANGELOG.md' ':!.nx/nx-release/tests/_fixtures' ':!.specify/memory/constitution.md'
# 旧形式の manifest（フェーズ 11 の後）
git ls-files 'plugins/pecot-workflow/.github/plugin/*' 'plugins/pecot-workflow/hooks/hooks-copilot.json'
```

期待:

- 1 つ目は、切り替えの前は 202 箇所（28 ファイル）。切り替えの後は、利用者向けの説明として一覧に載せた箇所だけ
- 2 つ目は、その場所を示す
- 3 つ目は 0 件。deny だけを持つ `lib/core/pecot-cli-deny.sh` は、この式に当たらない
- 4 つ目以降は 0 件

## 性能

計るのはフェーズ 11 の PR の中で 1 回。同じ端末で続けて、切り替えの前の `bin/pecot`（Python）と、後の `bin/pecot`（Node のミラー）を 5 回ずつ計る。初回の準備は数えない。

```bash
# 接続先は偽の GitHub サーバ（ループバック）。どちらの版でも同じ値にする
export PECOT_GITHUB_API_URL=http://127.0.0.1:<偽サーバのポート>
for i in 1 2 3 4 5; do /usr/bin/time -f %e "$PWD/plugins/pecot-workflow/bin/pecot" project info >/dev/null; done
```

Node の中央値が Python の中央値以下（SC-009）。2 つの中央値を、PR の本文と `.pecot/work/<Issue番号>/` に残す。

## Python と uv の無い環境

`PATH` の各ディレクトリから、python・python3・uv・uvx 以外へのリンクを張ったディレクトリを作り、その `PATH` のシェルを使う。
devcontainer の外の素の Node 環境でもよい。

```bash
bin="$PWD/.pecot/work/<Issue番号>/nopython-bin"
mkdir -p "$bin"
(
  IFS=:
  for dir in $PATH; do
    [ -d "$dir" ] || continue
    for entry in "$dir"/*; do
      name="${entry##*/}"
      case "$name" in python*|uv|uvx|pip*) continue ;; esac
      [ -x "$entry" ] && [ ! -d "$entry" ] || continue
      [ -e "$bin/$name" ] || ln -s "$entry" "$bin/$name"
    done
  done
)
env PATH="$bin" bash --noprofile --norc -c 'type -P python3 python uv uvx || echo "見つからない（期待どおり）"'
env PATH="$bin" bash --noprofile --norc -c 'type -P node shasum sort cut tar find xargs'
```

1 つ目の `env` が「見つからない」と出て、2 つ目の `env` が 7 つのコマンドのパスを出せば、この `PATH` のシェルから CUJ 1 を起動する。
`type -P` は、alias や関数を拾わず、`PATH` 上のファイルだけを見る。
同じ作り方は `plugins/pecot-workflow/cli-node/tests/bootstrap/run.sh` の `make_filtered_bin` にある。
