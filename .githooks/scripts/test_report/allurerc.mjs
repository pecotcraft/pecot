import { defineConfig } from "allure";

// 履歴のパスは CLI の引数で渡せないので、generate.py が --history のときだけ環境変数で渡す。
const historyPath = process.env.PECOT_REPORT_HISTORY;

// generate.py が手元でない実行で渡す、レーンごとの「コミット 試した run の URL」（Config.variables）。
function readVariables(text) {
  if (text === undefined) return undefined;
  const value = JSON.parse(text);
  const isRecord =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string");
  if (!isRecord) {
    throw new Error("PECOT_REPORT_VARIABLES が、値が文字列のオブジェクトではありません");
  }
  return value;
}

const variables = readVariables(process.env.PECOT_REPORT_VARIABLES);

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
  historyLimit: 3,
  flakyDetection: { includePassedTests: true },
  // 結果は、最初に合った規則の分類だけに入る。2・3 がすべての failed・broken を取るので、既定の英語の分類は出ない
  categories: {
    rules: [
      {
        id: "flaky",
        name: "不安定なテスト",
        matchers: { statuses: ["failed", "broken"], flaky: true },
        groupBy: [{ label: "epic" }],
      },
      {
        id: "product-errors",
        name: "製品の不具合",
        matchers: { statuses: ["failed"] },
        groupBy: [{ label: "epic" }],
      },
      {
        id: "test-errors",
        name: "テストの不具合",
        matchers: { statuses: ["broken"] },
        groupBy: [{ label: "epic" }],
      },
    ],
  },
  ...(historyPath ? { historyPath } : {}),
  ...(variables ? { variables } : {}),
});
