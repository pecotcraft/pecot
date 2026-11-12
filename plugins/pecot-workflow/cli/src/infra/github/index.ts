// GitHub API クライアント（REST と GraphQL、github.com と GHES に対応）。cli/core/github/__init__.py の移植。
//
// Python は IssuesAPI・ProjectsAPI・PullsAPI・ReposAPI の多重継承で合成していた。
// TypeScript は継承を一直線につなぐ。基底 → repos → projects → issues → pulls の順で、各ファイルが前のクラスを拡張する。
// この順は合成のための並びで、操作の依存を表さない。
// 操作どうしの実際の依存は projects が repos の getRepositoryId を呼ぶ 1 本だけ。

import { PullsApi } from './pulls.js'

/**
GitHub API クライアント。操作は責務別のクラスから合成する。

使い方は次のとおり。
- 作る: `new GitHubClient({ host: 'ghes.example.com', diagnostics })`。
- 呼ぶ: `await client.getIssueSlim('owner', 'repo', 123)`。

RepositoryMembership（domain/config.ts）と同じ形の linkedRepositories も持つ。
*/
export class GitHubClient extends PullsApi {}
