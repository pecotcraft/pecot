# リポジトリのルート直下のディレクトリ

ルート直下の `.` で始まらないディレクトリは、次の表のものだけにします。
`.` で始まるディレクトリと、ルート直下のファイルは、この決まりの対象外です。
`.githooks/pre-commit/check-root-entries.sh` が、追跡しているファイルの先頭のディレクトリを、この表と同じ一覧と比べて止めます。

| 名前 | 役割 |
|:---|:---|
| `libs` | ライブラリ（`libs/<name>/`） |
| `plugins` | 配布するプラグイン（`plugins/<name>/`） |
| `specs` | Spec Kit の仕様 |

## 一覧を増やすとき

一覧を増やすには、ユーザーの明示の同意が要ります。

- エージェントは、自分の判断で一覧を増やさない。hook を通すために増やすこともしない
- 増やしたいときは、名前・置くもの・既存の置き場所では足りない理由をユーザーに示し、同意を得てから直す
- hook の `ALLOWED` とこの表は、同じ変更で直す。一方だけだと `test_check_root_entries.py` が落ちる

## 新しいものの置き場所

ルートに新しいディレクトリを作らず、まず次の置き場所に入れます。

| 置くもの | 置き場所 |
|:---|:---|
| リポ全体で使うスクリプト（install・CI・リリース・hook の entry から呼ぶもの） | `.githooks/scripts/` |
| hook | `.githooks/<stage>/`（`pre-commit` / `commit-msg` / `pre-push`） |
| hook が共有する関数 | `.githooks/lib/` |
| root 共通のテスト | `.githooks/tests/` |
| プラグインの中身 | `plugins/<name>/` |
| ライブラリ | `libs/<name>/` |
| ワークフロー | `.github/workflows/` |
| 作業ファイル・evidence・スクラッチ | `.pecot/work/<Issue番号>/` |
