// GitHub GraphQL API のクエリ・mutation 文字列。
// 先頭の 30 個は cli/core/github/queries.py を gql が送る形で写し、一致は infra/github/tests/queries.test.ts が固定する。
// 末尾の blocked by 関係の 4 個は Python に無く、graphql-js の print の出力の形で書く。

// 着手の判定に使う、Issue の依存関係・種別・親のフィールド。Issue の依存関係に対応しない GHES では通らない
const ISSUE_READINESS_FIELDS = `
              issueType {
                name
              }
              subIssues(first: 1) {
                totalCount
              }
              parent {
                number
                repository {
                  owner {
                    login
                  }
                  name
                }
              }
              blockedBy(first: 1) {
                totalCount
              }`

// 一覧のクエリ。operationName が空なら無名。readinessFields は Issue の枝に足すフィールド
function listProjectItemsQuery(operationName: string, readinessFields: string): string {
  return `query${operationName === '' ? ' ' : ` ${operationName}`}($projectId: ID!, $cursor: String, $laneFieldName: String!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        nodes {
          id
          updatedAt
          fieldValues(first: 10) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                field {
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                  }
                }
                name
              }
            }
          }
          lane: fieldValueByName(name: $laneFieldName) {
            ... on ProjectV2ItemFieldSingleSelectValue {
              name
            }
          }
          content {
            ... on Issue {
              id
              number
              title
              state
              url${readinessFields}
              labels(first: 10) {
                nodes {
                  name
                }
              }
              repository {
                owner {
                  login
                }
                name
              }
            }
            ... on PullRequest {
              id
              number
              title
              state
              url
              repository {
                owner {
                  login
                }
                name
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
      laneField: field(name: $laneFieldName) {
        ... on ProjectV2SingleSelectField {
          options {
            name
          }
        }
      }
    }
  }
}`
}

// プロジェクトアイテム一覧取得（ページネーション対応）
export const QUERY_LIST_PROJECT_ITEMS = listProjectItemsQuery('', ISSUE_READINESS_FIELDS)

// 上の一覧から、Issue の依存関係に対応しない GHES で通らないフィールドを除いたもの
export const QUERY_LIST_PROJECT_ITEMS_LEGACY = listProjectItemsQuery('ListProjectItemsLegacy', '')

// Issue Node ID・タイトル取得
export const QUERY_GET_ISSUE_NODE_ID = `query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id
      title
    }
  }
}`

// プロジェクトNode ID取得（user版）
export const QUERY_GET_PROJECT_ID_USER = `query ($owner: String!, $projectNumber: Int!) {
  user(login: $owner) {
    projectV2(number: $projectNumber) {
      id
    }
  }
}`

// プロジェクトNode ID取得（organization版）
export const QUERY_GET_PROJECT_ID_ORG = `query ($owner: String!, $projectNumber: Int!) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) {
      id
    }
  }
}`

// リポジトリNode ID取得
export const QUERY_GET_REPOSITORY_ID = `query ($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
  }
}`

// プロジェクトにリポジトリをリンク
export const MUTATION_LINK_PROJECT_REPOSITORY = `mutation ($projectId: ID!, $repositoryId: ID!) {
  linkProjectV2ToRepository(
    input: { projectId: $projectId, repositoryId: $repositoryId }
  ) {
    repository {
      id
      nameWithOwner
    }
  }
}`

// ボードにアイテム追加
export const MUTATION_ADD_TO_PROJECT = `mutation ($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
    item {
      id
    }
  }
}`

// プロジェクトアイテムフィールド更新
export const MUTATION_UPDATE_PROJECT_ITEM_FIELD = `mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(
    input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }
  ) {
    projectV2Item {
      id
    }
  }
}`

// プロジェクトアイテム削除
export const MUTATION_DELETE_PROJECT_ITEM = `mutation ($projectId: ID!, $itemId: ID!) {
  deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
    deletedItemId
  }
}`

// サブIssue紐づけ
export const MUTATION_ADD_SUB_ISSUE = `mutation ($parentId: ID!, $childId: ID!) {
  addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) {
    issue {
      number
    }
    subIssue {
      number
    }
  }
}`

// リンクブランチ作成（Issueに紐づいたブランチ）
export const MUTATION_CREATE_LINKED_BRANCH = `mutation CreateLinkedBranch($input: CreateLinkedBranchInput!) {
  createLinkedBranch(input: $input) {
    linkedBranch {
      ref {
        name
        prefix
      }
    }
  }
}`

// リンクブランチを作れなかったときの、作り先のリポと同じ名前の ref。id は Repository か Issue の Node ID
export const QUERY_GET_BRANCH_REF_BY_NODE = `query ($id: ID!, $qualifiedName: String!) {
  node(id: $id) {
    ... on Repository {
      nameWithOwner
      ref(qualifiedName: $qualifiedName) {
        name
      }
    }
    ... on Issue {
      repository {
        nameWithOwner
        ref(qualifiedName: $qualifiedName) {
          name
        }
      }
    }
  }
}`

// Issue の Node ID と、つながったブランチ。件数は gh issue develop の ListLinkedBranches と同じ
export const QUERY_GET_ISSUE_LINKED_BRANCHES = `query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id
      linkedBranches(first: 30) {
        nodes {
          ref {
            name
            repository {
              nameWithOwner
            }
          }
        }
      }
    }
  }
}`

// Issue番号からプロジェクトアイテム取得（高速版）
export const QUERY_GET_ISSUE_PROJECT_ITEMS = `query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      projectItems(first: 20) {
        nodes {
          id
          isArchived
          project {
            id
          }
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                field {
                  ... on ProjectV2SingleSelectField {
                    id
                  }
                }
              }
            }
          }
          status: fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue {
              name
              field {
                ... on ProjectV2SingleSelectField {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
}`

// プロジェクトフィールド取得（user版）
export const QUERY_GET_PROJECT_FIELDS_USER = `query ($owner: String!, $projectNumber: Int!) {
  user(login: $owner) {
    projectV2(number: $projectNumber) {
      id
      title
      url
      fields(first: 50) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id
            databaseId
            name
            options {
              id
              name
              color
              description
            }
          }
          ... on ProjectV2Field {
            id
            name
          }
        }
      }
      views(first: 1) {
        nodes {
          number
        }
      }
    }
  }
}`

// プロジェクトフィールド取得（organization版）
export const QUERY_GET_PROJECT_FIELDS_ORG = `query ($owner: String!, $projectNumber: Int!) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) {
      id
      title
      url
      fields(first: 50) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id
            databaseId
            name
            options {
              id
              name
              color
              description
            }
          }
          ... on ProjectV2Field {
            id
            name
          }
        }
      }
      views(first: 1) {
        nodes {
          number
        }
      }
    }
  }
}`

// プロジェクトフィールド作成（SingleSelect用）
export const MUTATION_CREATE_PROJECT_FIELD = `mutation ($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
  createProjectV2Field(
    input: {
      projectId: $projectId
      dataType: SINGLE_SELECT
      name: $name
      singleSelectOptions: $options
    }
  ) {
    projectV2Field {
      ... on ProjectV2SingleSelectField {
        id
        name
        options {
          id
          name
        }
      }
    }
  }
}`

// プロジェクトフィールドの改名。選択肢を渡さないので、選択肢の ID と各 Item の値は残る
export const MUTATION_RENAME_PROJECT_FIELD = `mutation ($fieldId: ID!, $name: String!) {
  updateProjectV2Field(input: { fieldId: $fieldId, name: $name }) {
    projectV2Field {
      ... on ProjectV2SingleSelectField {
        id
        name
      }
    }
  }
}`

// プロジェクトフィールドの削除。フィールドの値も消え、戻らない
export const MUTATION_DELETE_PROJECT_FIELD = `mutation ($fieldId: ID!) {
  deleteProjectV2Field(input: { fieldId: $fieldId }) {
    projectV2Field {
      ... on ProjectV2FieldCommon {
        id
        name
      }
    }
  }
}`

// プロジェクトフィールドの選択肢の置き換え（SingleSelect用。一覧の全体を送る）
export const MUTATION_UPDATE_PROJECT_FIELD = `mutation ($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
  updateProjectV2Field(
    input: { fieldId: $fieldId, singleSelectOptions: $options }
  ) {
    projectV2Field {
      ... on ProjectV2SingleSelectField {
        id
        name
        options {
          id
          name
        }
      }
    }
  }
}`

// Issue 種別判定用クエリ（軽量・Epic 判定専用）
// Phase2: issueType.name == "Epic" を一次判定
export const QUERY_GET_ISSUE_KIND = `query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number
      state
      issueType {
        name
      }
      subIssues(first: 1) {
        totalCount
      }
    }
  }
}`

// issueType フィールド非対応 GHES 向けのフォールバック（Phase1 単独）
export const QUERY_GET_ISSUE_KIND_PHASE1 = `query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number
      state
      subIssues(first: 1) {
        totalCount
      }
    }
  }
}`

// Issue詳細取得のクエリ。blockedByCount は前提の件数のフィールド。Issue の依存関係に対応しない GHES では通らない
function getIssueSlimQuery(operationName: string, blockedByCount: string): string {
  return `query${operationName === '' ? ' ' : ` ${operationName}`}($owner: String!, $repo: String!, $number: Int!, $commentLimit: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number
      state
      title
      body
      comments(last: $commentLimit) {
        totalCount
        nodes {
          author {
            login
          }
          createdAt
          body
        }
      }
      parent {
        number
        title
        state
        repository {
          owner {
            login
          }
          name
        }
      }
      subIssues(first: 20) {
        nodes {
          number
          state
          title
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
      linkedBranches(first: 10) {
        nodes {
          ref {
            name
          }
        }
      }
      timelineItems(itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT], first: 20) {
        nodes {
          ... on ConnectedEvent {
            subject {
              ... on PullRequest {
                number
                title
                state
              }
            }
          }
          ... on CrossReferencedEvent {
            source {
              ... on PullRequest {
                number
                title
                state
              }
            }
          }
        }
      }${blockedByCount}
    }
  }
}`
}

// Issue詳細取得（スリム版 - 必要なフィールドのみ。前提の件数つき）
export const QUERY_GET_ISSUE_SLIM = getIssueSlimQuery('', `
      blockedBy(first: 1) {
        totalCount
      }`)

// 上のクエリから、前提の件数を除いたもの。Issue の依存関係を持たない GHES で読み直すのに使う
export const QUERY_GET_ISSUE_SLIM_WITHOUT_BLOCKED_BY = getIssueSlimQuery('GetIssueSlimWithoutBlockedBy', '')

// Python 版 queries.py の QUERY_GET_SUB_ISSUES_PAGE と逐語で一致させる。
export const QUERY_GET_SUB_ISSUES_PAGE = `query ($owner: String!, $repo: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      subIssues(first: 100, after: $after) {
        nodes {
          number
          state
          title
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`

// session finish が読む PR。closing issues のリポと、既定ブランチの名前を足す
export const QUERY_GET_PULL_REQUEST_FOR_FINISH = `query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      state
      body
      headRefName
      baseRefName
      isDraft
      closingIssuesReferences(first: 10) {
        nodes {
          number
          repository {
            name
            owner {
              login
            }
          }
        }
      }
      baseRepository {
        defaultBranchRef {
          name
        }
      }
    }
  }
}`

// open の PR の一覧。dependabot の PR の待ち状態の判定に使う。ページを辿る
// 入れ子の connection が多く、ノード数の上限に近づくので first は 25 にしている。
// timelineItems は、2 種のイベントを合わせて last: N だと force-push が多いときに片方が押し出されるため、
// 種類ごとに別名で最後の 1 件だけを取る。
export const QUERY_LIST_OPEN_PULL_REQUESTS = `query ($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(
      first: 25
      states: OPEN
      after: $after
      orderBy: { field: CREATED_AT, direction: ASC }
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        number
        title
        url
        createdAt
        author {
          __typename
          login
        }
        isInMergeQueue
        autoMergeRequest {
          enabledAt
        }
        mergeable
        baseRef {
          target {
            ... on Commit {
              committedDate
            }
          }
        }
        firstCommits: commits(first: 1) {
          nodes {
            commit {
              message
              signature {
                isValid
              }
              author {
                user {
                  login
                }
              }
            }
          }
        }
        headCommits: commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
              }
            }
          }
        }
        lastForcePush: timelineItems(last: 1, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
          nodes {
            ... on HeadRefForcePushedEvent {
              createdAt
            }
          }
        }
        lastDequeue: timelineItems(last: 1, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) {
          nodes {
            ... on RemovedFromMergeQueueEvent {
              createdAt
            }
          }
        }
      }
    }
  }
}`

// 前提（blocked by）を付ける。issueId が待つ側、blockingIssueId が前提
export const MUTATION_ADD_BLOCKED_BY = `mutation ($issueId: ID!, $blockingIssueId: ID!) {
  addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) {
    issue {
      number
    }
    blockingIssue {
      number
    }
  }
}`

// 前提（blocked by）を外す
export const MUTATION_REMOVE_BLOCKED_BY = `mutation ($issueId: ID!, $blockingIssueId: ID!) {
  removeBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) {
    issue {
      number
    }
    blockingIssue {
      number
    }
  }
}`

const PULL_REQUEST_FIELDS = `fragment PullRequestFields on PullRequest {
  number
  state
  headRefName
  baseRefName
  isDraft
  isCrossRepository
  repository {
    owner {
      login
    }
    name
  }
}`

const PREREQUISITE_ISSUE_FIELDS = `fragment PrerequisiteIssueFields on Issue {
  id
  number
  state
  title
  repository {
    owner {
      login
    }
    name
  }
  issueType {
    name
  }
  subIssues(first: 1) {
    totalCount
  }
  projectItems(first: 20, includeArchived: false) {
    totalCount
    nodes {
      project {
        id
      }
      fieldValues(first: 20) {
        nodes {
          ...SingleSelectValueFields
        }
      }
      label: fieldValueByName(name: $labelFieldName) {
        ...SingleSelectValueFields
      }
    }
  }
  linkedBranches(first: 10) {
    totalCount
    nodes {
      ref {
        name
        associatedPullRequests(first: 10) {
          totalCount
          nodes {
            ...PullRequestFields
          }
        }
      }
    }
  }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
    totalCount
    nodes {
      ...PullRequestFields
    }
  }
}`

const SINGLE_SELECT_VALUE_FIELDS = `fragment SingleSelectValueFields on ProjectV2ItemFieldValue {
  ... on ProjectV2ItemFieldSingleSelectValue {
    name
    optionId
    field {
      ... on ProjectV2SingleSelectField {
        id
        name
      }
    }
  }
}`

// Issue と、その前提（blockedBy）を 1 回で読む。PR は 2 つの読み口（リンクしたブランチと Development 欄）から集める
export const QUERY_GET_ISSUE_PREREQUISITES = `query ($owner: String!, $repo: String!, $number: Int!, $labelFieldName: String!, $blockedByFirst: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      ...PrerequisiteIssueFields
      body
      parent {
        number
        repository {
          owner {
            login
          }
          name
        }
      }
      blockedBy(first: $blockedByFirst) {
        totalCount
        nodes {
          ...PrerequisiteIssueFields
        }
      }
    }
  }
}

${PREREQUISITE_ISSUE_FIELDS}

${SINGLE_SELECT_VALUE_FIELDS}

${PULL_REQUEST_FIELDS}`

// head のブランチ名で PR を引く（open・closed・merged。新しい順）
export const QUERY_LIST_PULL_REQUESTS_BY_HEAD = `query ($owner: String!, $repo: String!, $headRefName: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(
      headRefName: $headRefName
      states: [OPEN, CLOSED, MERGED]
      first: 20
      orderBy: { field: CREATED_AT, direction: DESC }
    ) {
      pageInfo {
        hasNextPage
      }
      nodes {
        ...PullRequestFields
      }
    }
  }
}

${PULL_REQUEST_FIELDS}`

const BLOCKED_BY_REFERENCE_FIELDS = `fragment BlockedByReferenceFields on Issue {
  id
  number
  state
  repository {
    owner {
      login
    }
    name
  }
}`

// その Issue を前提にしている Issue（blocking）の参照。PR を作った後に、待つ側の Issue を絞るために読む
export const QUERY_GET_ISSUE_BLOCKING_REFERENCES = `query ($owner: String!, $repo: String!, $number: Int!, $blockingFirst: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      blocking(first: $blockingFirst) {
        totalCount
        nodes {
          ...BlockedByReferenceFields
        }
      }
    }
  }
}

${BLOCKED_BY_REFERENCE_FIELDS}`

// Issue 1 件の、指定のプロジェクトの項目と進行の列。ボード全体を読まずに、列を動かす対象を読む
export const QUERY_GET_ISSUE_BOARD_ITEM = `query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number
      title
      state
      url
      repository {
        owner {
          login
        }
        name
      }
      projectItems(first: 20, includeArchived: false) {
        nodes {
          id
          project {
            id
          }
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                field {
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                  }
                }
                name
              }
            }
          }
        }
      }
    }
  }
}`

// Lanes のビューを作る先。所有者の種類と個人の数値の id（REST のパス）、ビューの名前、欄の databaseId
export const QUERY_GET_PROJECT_VIEW_TARGET = `query ($owner: String!, $projectNumber: Int!) {
  repositoryOwner(login: $owner) {
    __typename
    ... on User {
      databaseId
    }
    ... on ProjectV2Owner {
      projectV2(number: $projectNumber) {
        url
        views(first: 50) {
          nodes {
            number
            name
          }
        }
        fields(first: 50) {
          nodes {
            ... on ProjectV2SingleSelectField {
              databaseId
              name
            }
          }
        }
      }
    }
  }
}`
