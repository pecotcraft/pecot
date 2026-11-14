# 既存設定検出の詳細

`/pecot-w:w-onboarding` Step 1 の補足。以下 4 パターンを優先順位順に確認し、最初にマッチしたケースで対処する。

## 1. カレントリポに設定あり

`project_list` を引数なしで呼ぶ。

`=== Projects ===` の次の行が `none` でなければ設定あり。AskUserQuestion でどの設定を使うか確認し、activate して Step 4 へ進む。`project_activate` を `project: "<設定ファイル名>"` で呼ぶ。

## 2. 兄弟リポに同一プロジェクトの設定あり

親ディレクトリ直下の兄弟リポを走査し、カレントリポと同じ `host`/`owner` を持つ設定ファイルを探す。

```bash
node --input-type=commonjs - <<'EOF'
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// git remote origin URL から host と owner を抽出
let origin
try {
  origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
} catch {
  console.log('ERROR: origin URL を取得できませんでした')
  process.exit(1)
}
const m = origin.match(/^git@([^:]+):([^/]+)\//) || origin.match(/^https?:\/\/([^/]+)\/([^/]+)\//)
if (!m) {
  console.log('ERROR: origin URL を解析できませんでした:', origin)
  process.exit(1)
}
const host = m[1]
const owner = m[2]

// 兄弟リポの設定ファイルを走査して host/owner が一致するものを列挙
const matches = []
let siblings
try {
  siblings = fs.readdirSync('..').sort()
} catch {
  console.log('ERROR: 親ディレクトリを読めませんでした')
  process.exit(1)
}
for (const sibling of siblings) {
  const dir = path.join('..', sibling, '.pecot', 'config', 'projects')
  let names
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
  } catch {
    continue
  }
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (cfg.host === host && cfg.owner === owner) matches.push(file)
    } catch {
      // 解析できない JSON は読み飛ばす
    }
  }
}

if (matches.length === 0) {
  console.log('兄弟リポに一致する設定ファイルが見つかりませんでした')
} else if (matches.length === 1) {
  console.log(`MATCH: ${matches[0]}`)
} else {
  console.log('複数見つかりました（AskUserQuestion で選択）:')
  for (const p of matches) console.log(`  ${p}`)
}
EOF
```

マッチした設定ファイルが 1 件なら確認なしでコピー、複数なら AskUserQuestion で選択させる。

```bash
mkdir -p .pecot/config/projects
cp <兄弟リポのJSONパス> .pecot/config/projects/
```

コピーしたら、`project_activate` を `project: "<コピーしたファイル名（拡張子なし）>"` で呼ぶ。

→ Step 3 へ（`repo_set` でカレントリポを登録してから Step 4 へ）。

## 3. GitHub 上に init 済みプロジェクトあり

AskUserQuestion でホスト・オーナーを確認してから検索する。`project_activate` を `host: "<host>"`・`owner: "<owner>"` で呼ぶ。

init 済みプロジェクトが表示されたら AskUserQuestion で選択させ、番号指定で activate する。`project_activate` を `project: "<番号>"`・`host: "<host>"`・`owner: "<owner>"` で呼ぶ。

→ Step 3 へ。

## 4. どれもない → 新規作成

→ Step 2 へ。
