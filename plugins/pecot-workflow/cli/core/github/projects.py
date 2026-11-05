"""GitHub Projects (v2) 操作の API。"""

from __future__ import annotations

from typing import Any, cast

from cli.core.github.auth import as_dict
from cli.core.github.errors import GitHubAPIError, GitHubNotFoundError
from cli.core.github.queries import (
    MUTATION_ADD_TO_PROJECT,
    MUTATION_CREATE_PROJECT,
    MUTATION_CREATE_PROJECT_FIELD,
    MUTATION_DELETE_PROJECT_ITEM,
    MUTATION_LINK_PROJECT_REPOSITORY,
    MUTATION_UPDATE_PROJECT_ITEM_FIELD,
    QUERY_GET_ISSUE_PROJECT_ITEMS,
    QUERY_GET_LINKED_REPOSITORIES_ORG,
    QUERY_GET_LINKED_REPOSITORIES_USER,
    QUERY_GET_ORG_NODE_ID,
    QUERY_GET_PROJECT_FIELDS_ORG,
    QUERY_GET_PROJECT_FIELDS_USER,
    QUERY_GET_PROJECT_ID_ORG,
    QUERY_GET_PROJECT_ID_USER,
    QUERY_GET_USER_NODE_ID,
    QUERY_LIST_PROJECT_ITEMS,
    QUERY_LIST_PROJECTS_ORG,
    QUERY_LIST_PROJECTS_USER,
)
from cli.core.github.repos import ReposAPI


class ProjectsAPI(ReposAPI):
    """GitHub Projects (v2) 操作の API。"""

    def list_project_items(
        self,
        project_id: str,
        limit: int | None = None,
        filter_query: str | None = None,
        exclude_archived: bool = False,
        workflow_field_name: str = "",
    ) -> list[dict[str, Any]]:
        """プロジェクトボードのアイテム一覧を取得（ページネーション対応）

        Args:
            project_id: プロジェクトのGraphQL Node ID。
            limit: 取得する最大件数（Noneの場合は全件）。
            filter_query: フィルタクエリ（現在未使用、将来の拡張用）。
            exclude_archived: Archivedステータスを除外する（高速化）。
            workflow_field_name: ワークフローフィールド名（exclude_archived時に使用）。

        Returns:
            アイテム情報のリスト
        """
        all_items: list[dict[str, Any]] = []
        cursor: str | None = None
        archived_consecutive_count = 0
        max_archived_consecutive = 50  # 連続してArchivedが50件続いたら打ち切り

        # フィルタクエリの有無で使用するGraphQLクエリを選択（現在は未使用）
        query_template = QUERY_LIST_PROJECT_ITEMS
        variables_base = {"projectId": project_id}

        while True:
            variables = {**variables_base, "cursor": cursor}
            result = self._execute_graphql(query_template, variables)

            node = result.get("node")
            if not node:
                break

            items_data = node.get("items", {})
            nodes = items_data.get("nodes", [])

            # exclude_archivedが有効な場合、Archivedを除外して早期終了判定
            if exclude_archived:
                for item in nodes:
                    # ワークフローステータスを確認
                    is_archived = self._is_item_archived(item, workflow_field_name)
                    if is_archived:
                        archived_consecutive_count += 1
                    else:
                        all_items.append(item)
                        archived_consecutive_count = 0

                    # 連続してArchivedが続いたら打ち切り
                    if archived_consecutive_count >= max_archived_consecutive:
                        return all_items
            else:
                all_items.extend(nodes)

            # 上限チェック
            if limit and len(all_items) >= limit:
                all_items = all_items[:limit]
                break

            # ページネーション
            page_info = items_data.get("pageInfo", {})
            if not page_info.get("hasNextPage"):
                break
            cursor = page_info.get("endCursor")

        return all_items

    def _is_item_archived(self, item: dict[str, Any], workflow_field_name: str) -> bool:
        """アイテムがArchivedかどうかを判定

        Args:
            item: プロジェクトアイテム
            workflow_field_name: ワークフローフィールド名

        Returns:
            Archivedの場合True
        """
        field_values = item.get("fieldValues", {})
        nodes = field_values.get("nodes", [])

        for node in nodes:
            if not node:
                continue
            field = node.get("field", {})
            field_name = field.get("name", "")
            if field_name.lower() == workflow_field_name.lower():
                status = node.get("name", "")
                return status.lower() == "archived"

        return False

    def add_to_project(self, project_id: str, content_id: str) -> str:
        """Issueをプロジェクトボードに追加

        Args:
            project_id: プロジェクトのGraphQL Node ID
            content_id: IssueのGraphQL Node ID

        Returns:
            作成されたアイテムのID

        Raises:
            GitHubAPIError: 追加に失敗した場合
        """
        result = self._execute_graphql(
            MUTATION_ADD_TO_PROJECT,
            {"projectId": project_id, "contentId": content_id},
        )

        item = result.get("addProjectV2ItemById", {}).get("item")
        if not item:
            raise GitHubAPIError("プロジェクトへの追加に失敗しました")
        return item["id"]

    def update_project_item_field(
        self,
        project_id: str,
        item_id: str,
        field_id: str,
        option_id: str,
    ) -> str:
        """プロジェクトアイテムのフィールド値を更新

        Args:
            project_id: プロジェクトのGraphQL Node ID
            item_id: アイテムのID
            field_id: フィールドのID
            option_id: 選択オプションのID

        Returns:
            更新されたアイテムのID

        Raises:
            GitHubAPIError: 更新に失敗した場合
        """
        result = self._execute_graphql(
            MUTATION_UPDATE_PROJECT_ITEM_FIELD,
            {
                "projectId": project_id,
                "itemId": item_id,
                "fieldId": field_id,
                "optionId": option_id,
            },
        )

        item = result.get("updateProjectV2ItemFieldValue", {}).get("projectV2Item")
        if not item:
            raise GitHubAPIError("フィールドの更新に失敗しました")
        return item["id"]

    def delete_project_item(self, project_id: str, item_id: str) -> str:
        """プロジェクトボードからアイテムを削除

        Args:
            project_id: プロジェクトのGraphQL Node ID
            item_id: アイテムのGraphQL Node ID

        Returns:
            削除されたアイテムのID

        Raises:
            GitHubAPIError: 削除に失敗した場合
        """
        result = self._execute_graphql(
            MUTATION_DELETE_PROJECT_ITEM,
            {"projectId": project_id, "itemId": item_id},
        )

        deleted_id = result.get("deleteProjectV2Item", {}).get("deletedItemId")
        if not deleted_id:
            raise GitHubAPIError("プロジェクトアイテムの削除に失敗しました")

        return deleted_id

    def get_linked_repositories(self, owner: str, project_number: int) -> list[dict[str, str]]:
        """プロジェクトにリンクされたリポジトリ一覧を取得

        user所有のプロジェクトを先に試し、見つからない場合は
        organization所有のプロジェクトを試す。

        Args:
            owner: プロジェクトオーナー
            project_number: プロジェクト番号

        Returns:
            リポジトリ情報のリスト（owner, nameを含む辞書）
        """
        # まずuserクエリを試す
        try:
            result = self._execute_graphql(
                QUERY_GET_LINKED_REPOSITORIES_USER,
                {"owner": owner, "projectNumber": project_number},
            )
            user_data = result.get("user")
            if user_data and user_data.get("projectV2"):
                repos = user_data["projectV2"].get("repositories", {}).get("nodes", [])
                return [{"owner": r["owner"]["login"], "name": r["name"]} for r in repos if r]
        except GitHubAPIError:
            pass

        # userが失敗したらorganizationクエリを試す
        result = self._execute_graphql(
            QUERY_GET_LINKED_REPOSITORIES_ORG,
            {"owner": owner, "projectNumber": project_number},
        )
        org_data = result.get("organization")
        if org_data and org_data.get("projectV2"):
            repos = org_data["projectV2"].get("repositories", {}).get("nodes", [])
            return [{"owner": r["owner"]["login"], "name": r["name"]} for r in repos if r]

        return []

    def get_linked_repositories_cached(
        self, owner: str, project_number: int
    ) -> list[dict[str, str]]:
        """プロジェクトにリンクされたリポジトリ一覧を取得（キャッシュ付き）

        同一セッション内で複数回呼び出された場合、キャッシュを返す。

        Args:
            owner: プロジェクトオーナー
            project_number: プロジェクト番号

        Returns:
            リポジトリ情報のリスト（owner, nameを含む辞書）
        """
        cache_key = f"{owner}/{project_number}"
        if cache_key not in self._linked_repos_cache:
            self._linked_repos_cache[cache_key] = self.get_linked_repositories(
                owner, project_number
            )
        return self._linked_repos_cache[cache_key]

    def get_project_id(self, owner: str, project_number: int) -> str:
        """プロジェクト番号からGraphQL Node IDを取得

        user所有のプロジェクトを先に試し、見つからない場合は
        organization所有のプロジェクトを試す。

        Args:
            owner: プロジェクトオーナー
            project_number: プロジェクト番号

        Returns:
            GraphQL Node ID

        Raises:
            GitHubNotFoundError: プロジェクトが見つからない場合
        """
        # まずuserクエリを試す
        try:
            result = self._execute_graphql(
                QUERY_GET_PROJECT_ID_USER,
                {"owner": owner, "projectNumber": project_number},
            )
            user_data = result.get("user")
            if user_data and user_data.get("projectV2"):
                return user_data["projectV2"]["id"]
        except GitHubAPIError:
            pass

        # userが失敗したらorganizationクエリを試す
        result = self._execute_graphql(
            QUERY_GET_PROJECT_ID_ORG,
            {"owner": owner, "projectNumber": project_number},
        )
        org_data = result.get("organization")
        if org_data and org_data.get("projectV2"):
            return org_data["projectV2"]["id"]

        raise GitHubNotFoundError(
            f"プロジェクトが見つかりません: {owner}/projects/{project_number}"
        )

    def get_item_id_by_issue(
        self,
        project_id: str,
        owner: str,
        repo: str,
        issue_number: int,
    ) -> str | None:
        """Issue番号からプロジェクトアイテムIDを取得（高速版）

        Issue番号から直接プロジェクトアイテムを取得し、
        指定されたプロジェクトIDにマッチするものを返す。
        全アイテム走査が不要なため高速。

        Args:
            project_id: プロジェクトのGraphQL Node ID
            owner: リポジトリオーナー
            repo: リポジトリ名
            issue_number: Issue番号

        Returns:
            アイテムID（見つからない場合はNone）
        """
        result = self._execute_graphql(
            QUERY_GET_ISSUE_PROJECT_ITEMS,
            {"owner": owner, "repo": repo, "number": issue_number},
        )

        repository = result.get("repository")
        if not repository:
            return None

        issue = repository.get("issue")
        if not issue:
            return None

        project_items = issue.get("projectItems", {}).get("nodes", [])

        # 指定されたプロジェクトIDにマッチするアイテムを検索
        for item in project_items:
            if item and item.get("project", {}).get("id") == project_id:
                return item["id"]

        return None

    def get_item_set_field_ids(
        self,
        project_id: str,
        owner: str,
        repo: str,
        issue_number: int,
        item_id: str,
    ) -> set[str]:
        """プロジェクトアイテムで値が入っている単一選択フィールドの ID を取得

        Args:
            project_id: プロジェクトのGraphQL Node ID。
            owner: リポジトリオーナー。
            repo: リポジトリ名。
            issue_number: Issue番号。
            item_id: プロジェクトアイテムID。

        Returns:
            値が入っているフィールド ID の集合（アイテムが見つからなければ空）
        """
        result = self._execute_graphql(
            QUERY_GET_ISSUE_PROJECT_ITEMS,
            {"owner": owner, "repo": repo, "number": issue_number},
        )
        issue = as_dict(as_dict(result.get("repository")).get("issue"))
        nodes = as_dict(issue.get("projectItems")).get("nodes")
        field_ids: set[str] = set()
        for item in cast("list[Any]", nodes) if isinstance(nodes, list) else []:
            item_dict = as_dict(item)
            if item_dict.get("id") != item_id:
                continue
            if as_dict(item_dict.get("project")).get("id") != project_id:
                continue
            values = as_dict(item_dict.get("fieldValues")).get("nodes")
            for value in cast("list[Any]", values) if isinstance(values, list) else []:
                field_id = as_dict(as_dict(value).get("field")).get("id")
                if isinstance(field_id, str):
                    field_ids.add(field_id)
        return field_ids

    def link_repository_to_project(
        self, owner: str, project_number: int, repo_owner: str, repo_name: str
    ) -> tuple[bool, str]:
        """プロジェクトにリポジトリをリンク

        GraphQL APIを使用してプロジェクトにリポジトリをリンクする。

        Args:
            owner: プロジェクトオーナー
            project_number: プロジェクト番号
            repo_owner: リポジトリオーナー
            repo_name: リポジトリ名

        Returns:
            (成功フラグ, メッセージ) のタプル。
            成功時: (True, "リンク成功メッセージ")。
            既にリンク済み: (True, "既にリンク済みメッセージ")。
            失敗時: (False, "エラーメッセージ")。
        """
        try:
            # プロジェクトIDを取得
            project_id = self.get_project_id(owner, project_number)

            # リポジトリIDを取得
            repository_id = self.get_repository_id(repo_owner, repo_name)

            # リンク実行
            result = self._execute_graphql(
                MUTATION_LINK_PROJECT_REPOSITORY,
                {"projectId": project_id, "repositoryId": repository_id},
            )

            link_result = result.get("linkProjectV2ToRepository", {})
            repository = link_result.get("repository")
            if repository:
                return (
                    True,
                    f"GitHub Projectにリンクしました: {repository.get('nameWithOwner', '')}",
                )

            return (False, "リンクに失敗しました: レスポンスが不正です")

        except GitHubNotFoundError as e:
            return (False, f"リンクに失敗しました: {e.message}")
        except GitHubAPIError as e:
            # 既にリンク済みの場合のエラーハンドリング
            error_msg = str(e.message).lower()
            if "already linked" in error_msg or "already exists" in error_msg:
                return (True, "既にリンク済みです")
            return (False, f"リンクに失敗しました: {e.message}")

    def list_projects(self, owner: str, limit: int = 20) -> list[dict[str, Any]]:
        """オーナーのプロジェクト一覧を取得

        user所有のプロジェクトを先に試し、見つからない場合は
        organization所有のプロジェクトを試す。

        Args:
            owner: プロジェクトオーナー
            limit: 取得する最大件数（デフォルト: 20）

        Returns:
            プロジェクト情報のリスト（number, title, url, id を含む辞書）
        """
        # まずuserクエリを試す
        try:
            result = self._execute_graphql(
                QUERY_LIST_PROJECTS_USER,
                {"owner": owner, "first": limit},
            )
            user_data = result.get("user")
            if user_data and user_data.get("projectsV2"):
                projects = user_data["projectsV2"].get("nodes", [])
                return [p for p in projects if p]
        except GitHubAPIError:
            pass

        # userが失敗したらorganizationクエリを試す
        result = self._execute_graphql(
            QUERY_LIST_PROJECTS_ORG,
            {"owner": owner, "first": limit},
        )
        org_data = result.get("organization")
        if org_data and org_data.get("projectsV2"):
            projects = org_data["projectsV2"].get("nodes", [])
            return [p for p in projects if p]

        return []

    def get_project_fields(self, owner: str, project_number: int) -> dict[str, Any] | None:
        """プロジェクトのフィールド一覧を取得

        user所有のプロジェクトを先に試し、見つからない場合は
        organization所有のプロジェクトを試す。

        Args:
            owner: プロジェクトオーナー
            project_number: プロジェクト番号

        Returns:
            プロジェクト情報（id, title, url, fields を含む辞書）
            見つからない場合はNone
        """
        # まずuserクエリを試す
        try:
            result = self._execute_graphql(
                QUERY_GET_PROJECT_FIELDS_USER,
                {"owner": owner, "projectNumber": project_number},
            )
            user_data = result.get("user")
            if user_data and user_data.get("projectV2"):
                return user_data["projectV2"]
        except GitHubAPIError:
            pass

        # userが失敗したらorganizationクエリを試す
        result = self._execute_graphql(
            QUERY_GET_PROJECT_FIELDS_ORG,
            {"owner": owner, "projectNumber": project_number},
        )
        org_data = result.get("organization")
        if org_data and org_data.get("projectV2"):
            return org_data["projectV2"]

        return None

    def create_project_field(
        self,
        project_id: str,
        name: str,
        options: list[dict[str, str]],
    ) -> dict[str, Any]:
        """プロジェクトにSingleSelectフィールドを作成

        Args:
            project_id: プロジェクトのGraphQL Node ID
            name: フィールド名
            options: オプションリスト（name, color, descriptionを含む辞書）

        Returns:
            作成されたフィールド情報（id, name, optionsを含む辞書）

        Raises:
            GitHubAPIError: フィールド作成に失敗した場合
        """
        result = self._execute_graphql(
            MUTATION_CREATE_PROJECT_FIELD,
            {
                "projectId": project_id,
                "name": name,
                "options": options,
            },
        )

        field = result.get("createProjectV2Field", {}).get("projectV2Field")
        if not field:
            raise GitHubAPIError("フィールドの作成に失敗しました")
        return field

    def get_owner_node_id(self, owner: str) -> str:
        """オーナー（user/org）のGraphQL Node IDを取得

        まずuserとして取得を試みる。userクエリは、該当するuserが無いと
        GraphQLエラー（NOT_FOUND）を返すため、失敗した場合はorganizationとして
        取得を試みる。organizationクエリの例外は握らず、そのまま伝播する。

        Args:
            owner: ユーザー名または組織名

        Returns:
            GraphQL Node ID

        Raises:
            GitHubNotFoundError: organizationの応答がnullの場合
            GitHubAPIError: organizationクエリの失敗（認証エラー等）
        """
        # まずuserクエリを試す（userが無いとGraphQLエラーになるため握る）
        try:
            result = self._execute_graphql(
                QUERY_GET_USER_NODE_ID,
                {"login": owner},
            )
            user_data = result.get("user")
            if user_data and user_data.get("id"):
                return user_data["id"]
        except GitHubAPIError:
            pass

        # userが失敗したらorganizationクエリを試す（例外は伝播させる）
        result = self._execute_graphql(
            QUERY_GET_ORG_NODE_ID,
            {"login": owner},
        )
        org_data = result.get("organization")
        if org_data and org_data.get("id"):
            return org_data["id"]

        raise GitHubNotFoundError(f"オーナーが見つかりません: {owner}")

    def create_project(self, owner_id: str, title: str) -> dict[str, Any]:
        """GitHub Projects V2を新規作成

        Args:
            owner_id: オーナーのGraphQL Node ID
            title: プロジェクトタイトル

        Returns:
            作成されたプロジェクト情報（id, number, title, urlを含む辞書）

        Raises:
            GitHubAPIError: プロジェクト作成に失敗した場合
        """
        try:
            result = self._execute_graphql(
                MUTATION_CREATE_PROJECT,
                {"ownerId": owner_id, "title": title},
            )

            project = result.get("createProjectV2", {}).get("projectV2")
            if not project:
                raise GitHubAPIError("プロジェクトの作成に失敗しました")
            return project
        except GitHubAPIError:
            raise
        except Exception as e:
            raise GitHubAPIError(f"プロジェクトの作成に失敗しました: {e}") from e
