import { RuleTester } from 'eslint';
import plugin from '../index.ts';

// vue-eslint-parser 以外のパーサ（テンプレート本体を訪問する手段が無い）では、
// 全規則が何も報告せず終了する。
const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

for (const [name, rule] of Object.entries(plugin.rules)) {
  ruleTester.run(`${name} (テンプレート解析なし)`, rule as never, {
    valid: [{ code: 'export default {}', filename: 'test.js' }],
    invalid: [],
  });
}
