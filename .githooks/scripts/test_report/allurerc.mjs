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
  ...(variables ? { variables } : {}),
});
