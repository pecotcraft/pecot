# pecot CLI テスト

## 配置

テストは実行方法で 4 つのディレクトリに分ける。`tests/` 直下にはテストファイルを置かない（`conftest.py` のみ）。

| ディレクトリ | 置いてよいもの | 置かないもの |
|---|---|---|
| `unit/` | 製品コードを実行しない静的な確認（AST による構造規約、テンプレート・文書・SKILL.md の内容確認） | `CliRunner` を使うテスト、製品関数を呼んで戻り値を検証するテスト |
| `core/` | `cli.core` の関数と `cli` パッケージ直下（`cli.__init__`・`cli.__main__`）を直接呼ぶテスト | `CliRunner` によるコマンド起動、subprocess による `pecot` の実起動 |
| `cli/` | `CliRunner` によるコマンドテスト（境界は `unittest.mock.patch` で差し替える）と、`cli.commands` 内部ヘルパーの直接テスト | `cli.core` の関数を呼んで戻り値を検証するテスト（例外・データクラス・定数の import は可）、respx・subprocess を使うテスト |
| `e2e/` | HTTP 層を respx で通すテスト、subprocess で `pecot` や実 git を起動する通しのテスト | `CliRunner` と `unittest.mock.patch` だけで完結するテスト（`cli/` に置く） |

## モックの使い分け

| 手段 | 用途 |
|---|---|
| `unittest.mock.patch` | 自モジュールの境界の差し替え（`cli.commands.<mod>.GitHubClient`・git 関数・config 読み込み等）。差し替え先は参照側モジュールの名前で指定する |
| `monkeypatch` | 環境変数・cwd・`PATH`・`sys.path` と、fixture 内での属性差し替え |
| `respx` | httpx を実際に通したうえでの HTTP リクエスト捕捉。GraphQL / REST の URL・リクエスト本文・呼び出し回数を検証する |

`patch.dict(os.environ)` は使わない（`monkeypatch.setenv` / `delenv` を使う）。httpx 自体を `patch` で差し替えない（HTTP を検証するテストは respx を使う）。

`conftest.py` の autouse fixture が全テストで `CLAUDE_PROJECT_DIR` を一時ディレクトリに固定し、`GIT_DIR` 等の `GIT_*` 環境変数を外す。実際のプロジェクトルート解決を検証するテストは `monkeypatch.delenv("CLAUDE_PROJECT_DIR")` で外す。

## 実行

```bash
plugins/pecot-workflow/scripts/ci/run-tests.sh --scope=py
```

`--scope=py` は同じ `tests/` を 2 回実行し、JUnit XML の結果を比較する。

- pass1: 通常の環境で並列実行し、coverage 80% を下限として判定する
- pass2: `env -i` で HOME・XDG・uv cache を空ディレクトリに隔離し、`GIT_DIR` を空リポジトリに向けて実行する

pass1 だけ通り pass2 で落ちる、または結果が食い違うテストは、ホスト側の設定・キャッシュ・git 状態に依存している。テストを直してホスト依存を外す。
