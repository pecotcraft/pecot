# 既存設定検出の詳細

`/pecot-w:w-onboarding` Step 1 の補足。以下 4 パターンを優先順位順に確認し、最初にマッチしたケースで対処する。

## 1. カレントリポに設定あり

`project_list` を引数なしで呼ぶ。

`=== Projects ===` の次の行が `none` でなければ設定あり。AskUserQuestion でどの設定を使うか確認し、activate して Step 4 へ進む。`project_activate` を `project: "<設定ファイル名>"` で呼ぶ。

## 2. 兄弟リポに同一プロジェクトの設定あり

親ディレクトリ直下の兄弟リポを走査し、カレントリポと同じ `host`/`owner` を持つ設定ファイルを探す。

```bash
python3 - <<'EOF'
import json, pathlib, re, subprocess

# git remote origin URL から host と owner を抽出
origin = subprocess.check_output(["git", "remote", "get-url", "origin"], text=True).strip()
m = re.match(r"git@([^:]+):([^/]+)/", origin) or re.match(r"https?://([^/]+)/([^/]+)/", origin)
if not m:
    print("ERROR: origin URL を解析できませんでした:", origin)
    raise SystemExit(1)
host, owner = m.group(1), m.group(2)

# 兄弟リポの設定ファイルを走査して host/owner が一致するものを列挙
matches = []
for p in pathlib.Path("..").glob("*/.pecot/config/projects/*.json"):
    try:
        cfg = json.loads(p.read_text())
        if cfg.get("host") == host and cfg.get("owner") == owner:
            matches.append(p)
    except Exception:
        pass

if not matches:
    print("兄弟リポに一致する設定ファイルが見つかりませんでした")
elif len(matches) == 1:
    print(f"MATCH: {matches[0]}")
else:
    print("複数見つかりました（AskUserQuestion で選択）:")
    for p in matches:
        print(f"  {p}")
EOF
```

マッチした設定ファイルが 1 件なら確認なしでコピー、複数なら AskUserQuestion で選択させる。

```bash
mkdir -p .pecot/config/projects
cp <兄弟リポのJSONパス> .pecot/config/projects/
```

コピーしたら、`project_activate` を `project: "<コピーしたファイル名（拡張子なし）>"` で呼ぶ。

→ Step 3 へ（`project_set_repo` でカレントリポを登録してから Step 4 へ）。

## 3. GitHub 上に init 済みプロジェクトあり

AskUserQuestion でホスト・オーナーを確認してから検索する。`project_activate` を `host: "<host>"`・`owner: "<owner>"` で呼ぶ。

init 済みプロジェクトが表示されたら AskUserQuestion で選択させ、番号指定で activate する。`project_activate` を `project: "<番号>"`・`host: "<host>"`・`owner: "<owner>"` で呼ぶ。

→ Step 3 へ。

## 4. どれもない → 新規作成

→ Step 2 へ。
