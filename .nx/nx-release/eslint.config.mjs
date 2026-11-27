import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import globals from "globals";

import { describeTitleConfig } from "../../libs/interface-spec/src/eslint/describe-title.ts";
import { tableKeyConfig } from "../../libs/interface-spec/src/eslint/table-key.ts";
import { testDescriptionConfig } from "../../libs/interface-spec/src/eslint/test-description.ts";

const testFiles = ["tests/**/*.test.mjs"];
const JA = String.raw`[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]`;
const NO_JA = "題に日本語が無い（.claude/rules/test-conventions.md）";
const KUTEN = "題が句点で終わる（.claude/rules/test-conventions.md）";

export default [
  { ignores: ["node_modules/**", "test-results/**"] },
  js.configs.recommended,
  { languageOptions: { sourceType: "commonjs", globals: globals.node } },
  { files: ["**/*.mjs"], languageOptions: { sourceType: "module" } },
  {
    files: testFiles,
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/valid-title": [
        "error",
        {
          mustMatch: { it: [JA, NO_JA], test: [JA, NO_JA] },
          mustNotMatch: { it: ["。$", KUTEN], test: ["。$", KUTEN] },
        },
      ],
    },
  },
  // nx-release は定義書を持たないので、tests/interface/ に describe を足すと、どの題も止まる。
  describeTitleConfig([]),
  tableKeyConfig(testFiles),
  testDescriptionConfig(testFiles),
];
