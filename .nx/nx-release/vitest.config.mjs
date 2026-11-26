import path from "node:path";

import { configDefaults, defineConfig } from "vitest/config";

import { allureReporter } from "../../libs/interface-spec/src/vitest/allure-reporter.js";

export default defineConfig({
  test: {
    reporters: [
      ...configDefaults.reporters,
      // interface-env: NX_TASK_TARGET_PROJECT NX_TASK_TARGET_TARGET PECOT_REPORT_SITE_URL
      ...allureReporter(import.meta.dirname),
    ],
    include: ["tests/*.test.mjs"],
    setupFiles: [path.resolve(import.meta.dirname, "../../libs/interface-spec/src/vitest/unique-titles.ts")],
    // git と子プロセスを動かすテストがある。cli の設定と同じ上限にする。
    testTimeout: 60_000,
  },
});
