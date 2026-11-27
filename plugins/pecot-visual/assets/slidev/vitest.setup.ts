// ESLint の RuleTester のケースを、説明の付いた vitest のテストとして 1 件ずつ並べる（ESLint の文書の「Customizing RuleTester」）。
import { RuleTester } from 'eslint'
import { useExplainedRuleTester } from '../../../../libs/interface-spec/src/vitest/rule-tester.js'

useExplainedRuleTester(RuleTester)
