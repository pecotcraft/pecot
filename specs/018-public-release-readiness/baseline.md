# Baseline: 改名の前のテストの件数とカバレッジ

aistcraft/aist-roadmap#20 の T002 の成果物。改名の前に、aist-plugin の main のテストの件数と行カバレッジを測った。aistcraft/aist-plugin#34 の T021 が、改名の後に同じ単位で測って、この表と比べる。

## 計測の条件

- 計測した日時: 2026-11-04 01:33 UTC
- aist-plugin の main の SHA: `5f74c424ed415b04fce6a55329987c8bd5afd398`
- 計測の前に、`git rev-parse HEAD` が上の SHA であり、`git status -s` が空であることを確かめた。
- 計測コマンド（キャッシュを外し、nx の出力を stream にする）:

```
cd /workspaces/aist/base/aist-plugin
NX_DAEMON=false npx nx run-many -t test -p aist-workflow aist-visual aist-tools text-rules nx-release --skip-nx-cache --outputStyle=stream
```

- 結果: 全 target が成功した。失敗したテストは 0 件。
- bash のレーンは、出力が入り交じって数えにくい。そこで target を 1 つずつ、次の形で測り直した。全て成功した。

```
NX_DAEMON=false npx nx run <project>:<target> --skip-nx-cache --outputStyle=stream
```

## 表

passed / skipped / failed は、各ランナーが数えた件数。pytest の pass1 と pass2 は同じ件数が二重に出るので、pass1 だけ数えた。

| project | レーン | ランナー | passed | skipped | failed | 行カバレッジ |
|---|---|---|---|---|---|---|
| aist-workflow | test-py | pytest（pass1） | 1879 | 0 | 0 | 91%（`--cov=cli` の TOTAL。coverage.py の文の網羅率） |
| aist-workflow | test-cli | vitest（project cli） | 3336 | 0 | 0 | 98.64%（2687/2724） |
| aist-workflow | test-hooks | pytest（pass1） | 1569 | 0 | 0 | 計測なし |
| aist-workflow | test-hooks | vitest（project hooks） | 1 | 0 | 0 | 計測なし |
| aist-workflow | test-skills | pytest | 45 | 2 | 0 | 計測なし |
| aist-visual | test-cli | vitest（unit） | 3018 | 3 | 0 | 98.79%（6413/6491） |
| aist-visual | test-cli | vitest（e2e） | 100 | 0 | 0 | 計測なし |
| aist-visual | test-slidev | node --test + c8 | 567 | 0 | 0 | 88.45%（7179/8116） |
| aist-visual | test-hooks | bash（*.test.sh） | 11 本 / PASS 269 行 | 0 | 0 | 計測なし |
| aist-visual | test-bootstrap | bash | 7 本（PASS 行は出ない） | 0 | 0 | 計測なし |
| aist-visual | test-compare | bash（*.test.sh） | 5 本 / PASS 193 行 | 0 | 0 | 計測なし |
| aist-visual | test-skills | bash（*.test.sh） | 6 本 / PASS 156 行 | 0 | 0 | 計測なし |
| aist-visual | test-release | bash（*.test.sh） | 4 本 / PASS 420 行 | 0 | 0 | 計測なし（比べる対象から外す） |
| aist-tools | test-cli | vitest（unit） | 1080 | 0 | 0 | 100%（813/813） |
| aist-tools | test-cli | vitest（e2e） | 18 | 0 | 0 | 計測なし |
| aist-tools | test-bootstrap | bash | 4 本（全 CUJ が通った） | 0 | 0 | 計測なし |
| aist-tools | test-release | bash（*.test.sh） | 2 本 / PASS 108 行 | 0 | 0 | 計測なし（比べる対象から外す） |
| text-rules | test-unit | vitest --coverage | 384 | 0 | 0 | 99.14%（699/705） |
| nx-release | test-unit | node --test | 16 | 0 | 0 | 計測なし |

bash のレーンには、件数を出さないスクリプトがある。そのため、次の 2 つで数えた。T021 も同じ数え方で測ること。

- 「本」は、実行した `*.test.sh` や bootstrap のスクリプトの数。
- 「PASS 行」は、出力に出た `PASS:` で始まる確認の行数。`PASS: N / FAIL: M` の集計行は除く。

## 注記

- test-release は外部の registry に依存する。#18 の段階 4・5 で中身も変わる。そのため、改名の前後で比べる対象から外す。表には参考として載せた。
- `plugins/aist-workflow/cli-node/tests/parity/baseline.json`（vitest の閾値が読む）とは別物。この表は改名の前後を比べる記録で、閾値の入力ではない。
- aistcraft/aist-plugin#34 の T021 が、この表と同じ単位で測り、後退していないことを確かめる。
- 計測のログは `.aist/work/20/` にある（`nx-test.log`、`lane-*.log`）。

## T001 の結果

`gh issue view <N> -R <repo> --json state` で確かめた（2026-11-04）。

| Issue | state |
|---|---|
| aistcraft/aist-plugin#28 | CLOSED |
| aistcraft/aist-plugin#30 | CLOSED |
| aistcraft/aist-roadmap#15 | CLOSED |

aistcraft/aist-roadmap#16 と #17 は、本ブランチの PR のマージで閉じる。

- ブランチ名: `feat/finish-external-migration-and-start-public-release/16`

## T021 の結果

aistcraft/aist-plugin#34 の T021 の成果物。改名の後に、上の表と同じ単位で測った。

- 計測した日: 2026-11-04
- HEAD: `ee6b4c4c`
- 計測コマンド: 上の「計測の条件」と同じ形で、project 名を `pecot-workflow`・`pecot-visual`・`pecot-tools` にして target ごとに測った。test-release は比べる対象から外す。
- 結果: 全 target で passed・skipped・failed の件数と行カバレッジが基準と同じだった。

| project | レーン | ランナー | passed | skipped | failed | 行カバレッジ |
|---|---|---|---|---|---|---|
| pecot-workflow | test-py | pytest（pass1） | 1879 | 0 | 0 | 91%（`--cov=cli` の TOTAL。coverage.py の文の網羅率） |
| pecot-workflow | test-cli | vitest（project cli） | 3336 | 0 | 0 | 98.64%（2687/2724） |
| pecot-workflow | test-hooks | pytest（pass1） | 1569 | 0 | 0 | 計測なし |
| pecot-workflow | test-hooks | vitest（project hooks） | 1 | 0 | 0 | 計測なし |
| pecot-workflow | test-skills | pytest | 45 | 2 | 0 | 計測なし |
| pecot-visual | test-cli | vitest（unit） | 3018 | 3 | 0 | 98.79%（6413/6491） |
| pecot-visual | test-cli | vitest（e2e） | 100 | 0 | 0 | 計測なし |
| pecot-visual | test-slidev | node --test + c8 | 567 | 0 | 0 | 88.45%（7179/8116） |
| pecot-visual | test-hooks | bash（*.test.sh） | 11 本 / PASS 269 行 | 0 | 0 | 計測なし |
| pecot-visual | test-bootstrap | bash | 7 本（PASS 行は出ない） | 0 | 0 | 計測なし |
| pecot-visual | test-compare | bash（*.test.sh） | 5 本 / PASS 193 行 | 0 | 0 | 計測なし |
| pecot-visual | test-skills | bash（*.test.sh） | 6 本 / PASS 156 行 | 0 | 0 | 計測なし |
| pecot-tools | test-cli | vitest（unit） | 1080 | 0 | 0 | 100%（813/813） |
| pecot-tools | test-cli | vitest（e2e） | 18 | 0 | 0 | 計測なし |
| pecot-tools | test-bootstrap | bash | 4 本（全 CUJ が通った） | 0 | 0 | 計測なし |
| text-rules | test-unit | vitest --coverage | 384 | 0 | 0 | 99.14%（699/705） |
| nx-release | test-unit | node --test | 16 | 0 | 0 | 計測なし |

- 計測のログは `.pecot/work/34/t021/` にある。
