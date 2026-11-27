// 書く前のチェックのツール（issue_check・issue_dependency_check・issue_comment_check）が共通で返す結果の形
import { z } from 'zod'

export const CHECK_PROBLEM = z.strictObject({
  issue: z.string().optional().describe('Issue the problem belongs to: a batch key or owner/repo/N (omitted when the check covers one target)'),
  field: z.string().describe('Name of the argument that breaks the rule (title, body, issue_fields.<name>, blocked_by.<i>, ...)'),
  code: z.string().describe('Kind of the problem (missing-section, extra-heading, cycle, ...)'),
  message: z.string().describe('What is wrong and how to fix it, with the expected value when there is one'),
  candidates: z.array(z.string()).optional().describe('Values that would be accepted (omitted when there is no fixed set)'),
})

export type CheckProblem = z.infer<typeof CHECK_PROBLEM>

export const CHECK_RESULT_SHAPE = {
  problems: z.array(CHECK_PROBLEM).describe('Rules the arguments break; when empty, the arguments can be passed to the write tool as they are'),
}
