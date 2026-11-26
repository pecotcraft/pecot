import { defineConfig } from "allure";

// 名前の付いた step を持たない passed のテストで、レーンを落とす quality gate（.claude/rules/test-conventions.md の「step」）。
// allure-vitest が expect() から作る step は名前を持たないものとして数えない。添付も steps に type: "attachment" で入る。
const MATCHER_STEP = "expect(";

const hasNamedStep = (steps) =>
  steps.some(
    (step) =>
      step.type === "step" &&
      (!step.name.startsWith(MATCHER_STEP) || hasNamedStep(step.steps ?? [])),
  );

// parametrize の行は fullName が同じなので、値を添えて見分ける。
const title = (tr) => {
  const name = tr.fullName ?? tr.name;
  const values = (tr.parameters ?? []).map((parameter) => `${parameter.name}=${parameter.value}`);
  return values.length > 0 ? `${name} [${values.join(", ")}]` : name;
};

const namedStepsRule = {
  rule: "namedSteps",
  message: ({ actual }) =>
    [
      `名前の付いた step を持たない passed のテストが ${actual.length} 件あります（.claude/rules/test-conventions.md の「step」）`,
      ...actual.map((name) => `   ${name}`),
    ].join("\n"),
  successMessage: () => "passed のテストは、どれも名前の付いた step を持ちます",
  // 渡された結果だけで決める。最後の検証には state が渡らない。
  validate: async ({ trs }) => {
    const missing = trs.filter((tr) => !hasNamedStep(tr.steps ?? []));
    return {
      success: missing.length === 0,
      actual: missing.map(title).sort(),
      testResults: missing.map((tr) => tr.id),
    };
  },
};

// allure quality-gate は結果を output に書く。step-gate.sh が一時ディレクトリを渡す。
const output = process.env.PECOT_STEP_GATE_OUTPUT;

export default defineConfig({
  ...(output ? { output } : {}),
  qualityGate: {
    // 落ちたテストと skip は、最初の step の前で止まることがあり、欠けと見分けられない。
    rules: [{ namedSteps: true, filter: (tr) => tr.status === "passed" }],
    use: [namedStepsRule],
  },
});
