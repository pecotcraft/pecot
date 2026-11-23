import { defineConfig } from "allure";

// 履歴のパスは CLI の引数で渡せないので、generate.py が --history のときだけ環境変数で渡す。
const historyPath = process.env.PECOT_REPORT_HISTORY;

export default defineConfig({
  name: "pecot テストレポート",
  plugins: {
    awesome: {
      options: {
        groupBy: ["project", "lane", "parentSuite", "suite", "subSuite"],
        reportLanguage: "ja",
      },
    },
  },
  historyLimit: 20,
  flakyDetection: { includePassedTests: true },
  ...(historyPath ? { historyPath } : {}),
});
