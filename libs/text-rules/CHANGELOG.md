## 0.2.4 (2026-11-09)

### 🩹 Fixes

- テストの target の説明文を、CI がテストを動かす前提に直した。動きは変わらない。 ([#144](https://github.com/pecotcraft/pecot/pull/144), [#66](https://github.com/pecotcraft/pecot/issues/66))
- リポジトリを root の 1 つの pnpm workspace にまとめ、lock を root の 1 つにした。libs/text-rules は workspace: で参照する。 ([#115](https://github.com/pecotcraft/pecot/pull/115), [#113](https://github.com/pecotcraft/pecot/issues/113))
- テストの上限を 30 秒に延ばす。配布物の動作は変わらない。 ([#132](https://github.com/pecotcraft/pecot/pull/132), [#131](https://github.com/pecotcraft/pecot/issues/131))
- 違うパッケージマネージャの install を、各 package.json の devEngines.packageManager で止めるようにした。 ([#81](https://github.com/pecotcraft/pecot/pull/81), [#52](https://github.com/pecotcraft/pecot/issues/52))
- `scripts/ready.mjs` は、root フックが dist を使えるかを判定する。CodeQL が構文エラーとして解析から外していたので、読める書き方へ改めた。判定の結果は変わらない。 ([#73](https://github.com/pecotcraft/pecot/pull/73), [#58](https://github.com/pecotcraft/pecot/issues/58))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 0.2.3 (2026-11-04)

pecotcraft/pecot で公開した最初の版。
