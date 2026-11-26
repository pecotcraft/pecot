// ESLint の RuleTester のケースを、vitest のテストとして 1 件ずつ並べる（ESLint の文書の「Customizing RuleTester」）。
import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only
