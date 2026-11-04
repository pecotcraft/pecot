# Secret Scan: 公開の前の秘密情報のスキャン

pecotcraft/aist-plugin#35 の T027 の成果物。SC-009 の判定に使う。
記録の形は data-model.md の「秘密情報のスキャンの結果」に従う。

## スキャンの条件

| 項目 | 内容 |
|---|---|
| スキャナと版 | gitleaks v8.30.1（`gitleaks_8.30.1_linux_x64.tar.gz`。公開の checksums の SHA-256 と一致を確かめた） |
| 規則 | 既定の規則。リポに `.gitleaks.toml` と `.gitleaksignore` は無い |
| 既定の除外 | 既定の設定は、lockfile・画像・書体・`node_modules` を読まない。除外を外した設定で読み直しても、検出は下の表と同じだった |
| commit | `ada0a3549be743d2dbaacf1da9dc51e5b5ce2bfe`（merge 前のブランチ `feat/public-content-audit/35`） |
| tree | `6cf0a3025a5bb228cbff044d6ad9d67f0d024471`（squash merge の後も、同じ中身ならこの SHA で辿れる） |
| 対象 | `git archive HEAD` を展開した追跡ファイルの木（4015 ファイル）と、同じ commit で作った 2 つの配布ツリー |

```bash
git archive HEAD | tar -x -C <展開先>
gitleaks dir <展開先> --redact --report-format json --report-path <記録>
gitleaks dir <配布ツリー> --redact --report-format json --report-path <記録>
```

配布ツリーも見た。`cli/dist` と `npm-shrinkwrap.json` は git に無いが、npm の配布物には入る。

## 検出

| ファイル | 行 | 規則 | 決定 | 理由 |
|---|---|---|---|---|
| `plugins/pecot-tools/cli/tests/_fixtures/fake-aws/fixtures/lambda-list-functions.stdout` | 24 | generic-api-key | 秘密ではない | テストの偽の AWS の応答の `NextToken`。base64 を戻すと `{"Marker": "order-notifier"}` |
| `plugins/pecot-tools/cli/tests/_fixtures/fake-aws/fixtures/paginated.stdout` | 3 | generic-api-key | 秘密ではない | テストの偽の AWS の応答の `NextToken`。base64 を戻すと `{"next": 1}` |
| `plugins/pecot-tools/cli/src/mcp/tools/tests/_shared.test.ts` | 220 | generic-api-key（2 件） | 秘密ではない | 上の `paginated.stdout` の `NextToken` を期待値として書いたもの |

2 つの配布ツリーの検出は 0 件。理由の無い検出は 0 件。

## 1 commit の時点のやり直し

1 commit にまとめる main の SHA で、#37 の T037 がスキャンをやり直す。
