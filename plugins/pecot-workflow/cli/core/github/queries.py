"""GitHub GraphQL API のクエリ・mutation 文字列。"""

# プロジェクトアイテム一覧取得（ページネーション対応）
QUERY_LIST_PROJECT_ITEMS = """
query($projectId: ID!, $cursor: String) {
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
                    name
                  }
                }
                name
              }
            }
          }
          content {
            ... on Issue {
              id
              number
              title
              state
              url
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
    }
  }
}
"""

# プロジェクトアイテム一覧取得（フィルタリング対応）
QUERY_LIST_PROJECT_ITEMS_FILTERED = """
query($projectId: ID!, $cursor: String, $filterQuery: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor, query: $filterQuery) {
        nodes {
          id
          updatedAt
          fieldValues(first: 10) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                field {
                  ... on ProjectV2SingleSelectField {
                    name
                  }
                }
                name
              }
            }
          }
          content {
            ... on Issue {
              id
              number
              title
              state
              url
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
    }
  }
}
"""

# Issue Node ID・タイトル取得
QUERY_GET_ISSUE_NODE_ID = """
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id
      title
    }
  }
}
"""

# リンクリポジトリ取得（user版）
QUERY_GET_LINKED_REPOSITORIES_USER = """
query($owner: String!, $projectNumber: Int!) {
  user(login: $owner) {
    projectV2(number: $projectNumber) {
      repositories(first: 100) {
        nodes {
          owner {
            login
          }
          name
        }
      }
    }
  }
}
"""

# リンクリポジトリ取得（organization版）
QUERY_GET_LINKED_REPOSITORIES_ORG = """
query($owner: String!, $projectNumber: Int!) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) {
      repositories(first: 100) {
        nodes {
          owner {
            login
          }
          name
        }
      }
    }
  }
}
"""

# プロジェクトNode ID取得（user版）
QUERY_GET_PROJECT_ID_USER = """
query($owner: String!, $projectNumber: Int!) {
  user(login: $owner) {
    projectV2(number: $projectNumber) {
      id
    }
  }
}
"""

# プロジェクトNode ID取得（organization版）
QUERY_GET_PROJECT_ID_ORG = """
query($owner: String!, $projectNumber: Int!) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) {
      id
    }
  }
}
"""

# リポジトリNode ID取得
QUERY_GET_REPOSITORY_ID = """
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
  }
}
"""

# プロジェクトにリポジトリをリンク
MUTATION_LINK_PROJECT_REPOSITORY = """
mutation($projectId: ID!, $repositoryId: ID!) {
  linkProjectV2ToRepository(input: {
    projectId: $projectId
    repositoryId: $repositoryId
  }) {
    repository {
      id
      nameWithOwner
    }
  }
}
"""

# ボードにアイテム追加
MUTATION_ADD_TO_PROJECT = """
mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: {
    projectId: $projectId
    contentId: $contentId
  }) {
    item {
      id
    }
  }
}
"""

# プロジェクトアイテムフィールド更新
MUTATION_UPDATE_PROJECT_ITEM_FIELD = """
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $fieldId
    value: {
      singleSelectOptionId: $optionId
    }
  }) {
    projectV2Item {
      id
    }
  }
}
"""

# プロジェクトアイテム削除
MUTATION_DELETE_PROJECT_ITEM = """
mutation($projectId: ID!, $itemId: ID!) {
  deleteProjectV2Item(
    input: {
      projectId: $projectId
      itemId: $itemId
    }
  ) {
    deletedItemId
  }
}
"""

# サブIssue紐づけ
MUTATION_ADD_SUB_ISSUE = """
mutation($parentId: ID!, $childId: ID!) {
  addSubIssue(input: {
    issueId: $parentId
    subIssueId: $childId
  }) {
    issue {
      number
    }
    subIssue {
      number
    }
  }
}
"""

# リンクブランチ作成（Issueに紐づいたブランチ）
MUTATION_CREATE_LINKED_BRANCH = """
mutation CreateLinkedBranch($input: CreateLinkedBranchInput!) {
  createLinkedBranch(input: $input) {
    linkedBranch {
      ref {
        name
        prefix
      }
    }
  }
}
"""

# Issue番号からプロジェクトアイテム取得（高速版）
QUERY_GET_ISSUE_PROJECT_ITEMS = """
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      projectItems(first: 20) {
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
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
"""

# プロジェクト一覧取得（user版）
QUERY_LIST_PROJECTS_USER = """
query($owner: String!, $first: Int!) {
  user(login: $owner) {
    projectsV2(first: $first) {
      nodes {
        number
        title
        url
        id
      }
    }
  }
}
"""

# プロジェクト一覧取得（organization版）
QUERY_LIST_PROJECTS_ORG = """
query($owner: String!, $first: Int!) {
  organization(login: $owner) {
    projectsV2(first: $first) {
      nodes {
        number
        title
        url
        id
      }
    }
  }
}
"""

# プロジェクトフィールド取得（user版）
QUERY_GET_PROJECT_FIELDS_USER = """
query($owner: String!, $projectNumber: Int!) {
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
}
"""

# プロジェクトフィールド取得（organization版）
QUERY_GET_PROJECT_FIELDS_ORG = """
query($owner: String!, $projectNumber: Int!) {
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
}
"""

# プロジェクトフィールド作成（SingleSelect用）
MUTATION_CREATE_PROJECT_FIELD = """
mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
  createProjectV2Field(input: {
    projectId: $projectId
    dataType: SINGLE_SELECT
    name: $name
    singleSelectOptions: $options
  }) {
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
}
"""

# ユーザーNode ID取得
QUERY_GET_USER_NODE_ID = """
query($login: String!) {
  user(login: $login) {
    id
  }
}
"""

# 組織Node ID取得
QUERY_GET_ORG_NODE_ID = """
query($login: String!) {
  organization(login: $login) {
    id
  }
}
"""

# プロジェクト作成
MUTATION_CREATE_PROJECT = """
mutation($ownerId: ID!, $title: String!) {
  createProjectV2(input: {
    ownerId: $ownerId
    title: $title
  }) {
    projectV2 {
      id
      number
      title
      url
    }
  }
}
"""

# Issue 種別判定用クエリ（軽量・Epic 判定専用）
# Phase2: issueType.name == "Epic" を一次判定
QUERY_GET_ISSUE_KIND = """
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number
      state
      issueType { name }
      subIssues(first: 1) { totalCount }
    }
  }
}
"""

# issueType フィールド非対応 GHES 向けのフォールバック（Phase1 単独）
QUERY_GET_ISSUE_KIND_PHASE1 = """
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number
      state
      subIssues(first: 1) { totalCount }
    }
  }
}
"""

# Issue詳細取得（スリム版 - 必要なフィールドのみ）
QUERY_GET_ISSUE_SLIM = """
query($owner: String!, $repo: String!, $number: Int!, $commentLimit: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number
      state
      title
      body
      comments(last: $commentLimit) {
        totalCount
        nodes {
          author { login }
          createdAt
          body
        }
      }
      parent {
        number
        title
        state
        repository { owner { login } name }
      }
      subIssues(first: 20) {
        nodes {
          number
          state
          title
        }
        pageInfo { hasNextPage endCursor }
      }
      linkedBranches(first: 10) {
        nodes {
          ref { name }
        }
      }
      timelineItems(itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT], first: 20) {
        nodes {
          ... on ConnectedEvent {
            subject {
              ... on PullRequest { number title state }
            }
          }
          ... on CrossReferencedEvent {
            source {
              ... on PullRequest { number title state }
            }
          }
        }
      }
    }
  }
}
"""

# サブIssueの続きのページ取得（QUERY_GET_ISSUE_SLIM が 20 件で打ち切られたとき用）
QUERY_GET_SUB_ISSUES_PAGE = """
query($owner: String!, $repo: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      subIssues(first: 100, after: $after) {
        nodes {
          number
          state
          title
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
"""


# PR詳細取得（スリム版 - 必要なフィールドのみ）
QUERY_GET_PULL_REQUEST_SLIM = """
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      state
      title
      body
      headRefName
      baseRefName
      isDraft
      mergeable
      comments { totalCount }
      closingIssuesReferences(first: 10) {
        nodes {
          number
          title
        }
      }
      reviews(first: 10) {
        nodes {
          state
          author { login }
        }
      }
    }
  }
}
"""

# PR詳細取得（レビュー詳細付き - --reviews オプション用）
QUERY_GET_PULL_REQUEST_WITH_REVIEWS = """
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      state
      title
      body
      headRefName
      baseRefName
      isDraft
      mergeable
      comments { totalCount }
      closingIssuesReferences(first: 10) {
        nodes {
          number
          title
        }
      }
      reviews(first: 20) {
        nodes {
          state
          body
          author { login }
          submittedAt
        }
      }
      reviewThreads(first: 50) {
        nodes {
          isResolved
          path
          line
          comments(first: 10) {
            nodes {
              author { login }
              body
              createdAt
            }
          }
        }
      }
    }
  }
}
"""
