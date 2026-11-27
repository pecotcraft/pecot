import { defineConfig } from "allure";

// 履歴のパスは CLI の引数で渡せないので、generate.py が --history のときだけ環境変数で渡す。
const historyPath = process.env.PECOT_REPORT_HISTORY;

export default defineConfig({
  name: "pecot テストレポート",
  plugins: {
    awesome: {
      options: {
        groupBy: ["epic", "feature", "story"],
        reportLanguage: "ja",
      },
    },
  },
  // Allure の既定の 2 つと同じ名前にして既定の id にまとめ、落ちたテストを重大度ごとに並べる。
  categories: {
    rules: [
      { name: "Product errors", matchers: { statuses: ["failed"] }, groupBy: ["severity"] },
      { name: "Test errors", matchers: { statuses: ["broken"] }, groupBy: ["severity"] },
    ],
  },
  historyLimit: 3,
  flakyDetection: { includePassedTests: true },
  ...(historyPath ? { historyPath } : {}),
});
