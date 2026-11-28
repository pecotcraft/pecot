// github-ops の operation の params の形。actions の github-ops と、書く前のチェック（pecot-workflow）が同じものを使う
import { z } from 'zod'

const NUMBER = z.number().int().min(1)
const NAME = z.string().min(1)
const REPOSITORY = z.string().refine(value => /^[\w.-]+\/[\w.-]+$/u.test(value), 'owner/repo')

const OPTION = z.strictObject({
  name: NAME,
  color: z.string().min(1).optional(),
  description: z.string().optional(),
})

export type FieldOption = z.output<typeof OPTION>

/**
project-fields の changes の 1 件
*/
export const FIELD_CHANGE = z.union([
  z.strictObject({ action: z.enum(['create']), name: NAME, options: z.array(OPTION).min(1) }),
  z.strictObject({ action: z.enum(['rename']), name: NAME, to: NAME }),
  z.strictObject({ action: z.enum(['delete']), name: NAME }),
  z.strictObject({ action: z.enum(['set-options']), name: NAME, options: z.array(OPTION).min(1) }),
])

export type FieldChange = z.output<typeof FIELD_CHANGE>

export const LINK_BRANCH_PARAMS = z.strictObject({ issue: NUMBER, branch: NAME, base: NAME.optional() })

export const STACK_REGISTER_PARAMS = z.strictObject({ pr: NUMBER, parent_pr: NUMBER })

export const PROJECT_FIELDS_PARAMS = z.strictObject({ project: NUMBER, changes: z.array(FIELD_CHANGE).min(1) })

export const PROJECT_VIEW_PARAMS = z.strictObject({ project: NUMBER, name: NAME, column: NAME, row: NAME })

export const PROJECT_LINK_PARAMS = z.strictObject({ project: NUMBER, repo: REPOSITORY.optional() })

export const NO_PARAMS = z.strictObject({})

export const RELEASE_CREATE_PARAMS = z.strictObject({
  tag: NAME,
  sha: z.string().refine(value => /^[\da-f]{40}$/u.test(value), 'a full commit SHA'),
  body: z.string(),
  name: NAME.optional(),
  prerelease: z.boolean().default(false),
})
