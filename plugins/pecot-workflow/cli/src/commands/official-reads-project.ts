// 公式の GitHub MCP の、ボードの一覧・ビュー・欄・ボード 1 つを読む結果の形。
// 型付きの出力（{ method, projects: { projects, pageInfo } }）と、v2.3.0 の平らな形（{ projects, pageInfo }）の両方を受ける。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- zod が推論する結果の型は readonly にできない */
import { z } from 'zod'

const PAGE_INFO = z.looseObject({ hasNextPage: z.boolean().optional() })

const PROJECT = z.looseObject({
  id: z.number().int().optional(),
  node_id: z.string().optional(),
  number: z.number().int().optional(),
  title: z.string().optional(),
  owner: z.looseObject({ login: z.string().optional() }).nullable().optional(),
  owner_type: z.string().optional(),
})

export type ReadProject = z.infer<typeof PROJECT>

const PROJECT_PAGE = z.looseObject({ projects: z.array(PROJECT).nullable().optional(), pageInfo: PAGE_INFO.optional() })

/**
projects_list（method: list_projects）の structuredContent
*/
const FLAT_PROJECTS = z.looseObject({ projects: z.array(PROJECT).nullable(), pageInfo: PAGE_INFO.optional() })

export const LIST_PROJECTS = z.union([z.looseObject({ projects: PROJECT_PAGE }), FLAT_PROJECTS])

export type ListProjects = z.infer<typeof LIST_PROJECTS>

/**
list_projects の 1 ページの、ボードと続きのページの有無
*/
export function projectsPageOf(read: ListProjects): { readonly projects: readonly ReadProject[], readonly hasNextPage: boolean } {
  if (Array.isArray(read.projects) || read.projects === null) {
    const flat = FLAT_PROJECTS.parse(read)
    return { projects: flat.projects ?? [], hasNextPage: flat.pageInfo?.hasNextPage === true }
  }
  return { projects: read.projects.projects ?? [], hasNextPage: read.projects.pageInfo?.hasNextPage === true }
}

/**
projects_get（method: get_project）の structuredContent
*/
export const GET_PROJECT = z.union([z.looseObject({ project: PROJECT }), PROJECT])

export function projectOf(read: z.infer<typeof GET_PROJECT>): ReadProject {
  const wrapped = 'project' in read ? PROJECT.safeParse(read.project) : undefined
  return wrapped?.success === true ? wrapped.data : PROJECT.parse(read)
}

const VIEW = z.looseObject({ number: z.number().int(), name: z.string().optional() })

const VIEW_LIST = z.array(VIEW).nullable()

const NESTED_VIEWS = z.looseObject({ views: VIEW_LIST.optional() })

/**
projects_list（method: list_project_views）の structuredContent
*/
export const LIST_PROJECT_VIEWS = z.union([
  z.looseObject({ views: NESTED_VIEWS }),
  z.looseObject({ views: VIEW_LIST }),
])

/**
ビューの番号（読んだ順）
*/
export function viewNumbersOf(read: z.infer<typeof LIST_PROJECT_VIEWS>): readonly number[] {
  const views = Array.isArray(read.views) || read.views === null ? read.views : read.views.views
  return (views ?? []).map(view => view.number)
}

/**
list_project_fields の続きのページの有無。欄の中身は official-reads.ts の PROJECTS_LIST_FIELDS で読む
*/
export const PROJECT_FIELDS_PAGE = z.looseObject({ fields: z.looseObject({ pageInfo: PAGE_INFO.optional() }) })
