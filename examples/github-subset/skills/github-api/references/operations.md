# GitHub REST API (subset): operations

38 operations. Mode: read-only.

## Tool `activity`

### activity/list-stargazers-for-repo

`GET /repos/{owner}/{repo}/stargazers`

List stargazers

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `activity/list-stargazers-for-repo(owner: string, repo: string, per_page?: integer, page?: integer)`

## Tool `issues`

### issues/list-for-repo

`GET /repos/{owner}/{repo}/issues`

List repository issues

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `state` | query | "open"\|"closed"\|"all" | no |  |
| `labels` | query | string | no | Comma separated list of label names |
| `assignee` | query | string | no |  |
| `sort` | query | "created"\|"updated"\|"comments" | no |  |
| `direction` | query | "asc"\|"desc" | no |  |
| `since` | query | string(date-time) | no |  |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `issues/list-for-repo(owner: string, repo: string, state?: "open"|"closed"|"all", labels?: string, assignee?: string, sort?: "created"|"updated"|"comments", direction?: "asc"|"desc", since?: string(date-time), per_page…)`

### issues/get

`GET /repos/{owner}/{repo}/issues/{issue_number}`

Get an issue

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `issue_number` | path | integer | yes | The number that identifies the issue. |

Signature: `issues/get(owner: string, repo: string, issue_number: integer)`

### issues/list-comments

`GET /repos/{owner}/{repo}/issues/{issue_number}/comments`

List issue comments

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `issue_number` | path | integer | yes | The number that identifies the issue. |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `issues/list-comments(owner: string, repo: string, issue_number: integer, per_page?: integer, page?: integer)`

### issues/list-labels-for-repo

`GET /repos/{owner}/{repo}/labels`

List labels for a repository

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `issues/list-labels-for-repo(owner: string, repo: string, per_page?: integer, page?: integer)`

## Tool `pulls`

### pulls/list

`GET /repos/{owner}/{repo}/pulls`

List pull requests

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `state` | query | "open"\|"closed"\|"all" | no |  |
| `base` | query | string | no | Filter by base branch name. |
| `sort` | query | "created"\|"updated"\|"popularity"\|"long-running" | no |  |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `pulls/list(owner: string, repo: string, state?: "open"|"closed"|"all", base?: string, sort?: "created"|"updated"|"popularity"|"long-running", per_page?: integer, page?: integer)`

### pulls/get

`GET /repos/{owner}/{repo}/pulls/{pull_number}`

Get a pull request

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `pull_number` | path | integer | yes | The number that identifies the pull request. |

Signature: `pulls/get(owner: string, repo: string, pull_number: integer)`

### pulls/list-files

`GET /repos/{owner}/{repo}/pulls/{pull_number}/files`

List pull request files

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `pull_number` | path | integer | yes | The number that identifies the pull request. |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `pulls/list-files(owner: string, repo: string, pull_number: integer, per_page?: integer, page?: integer)`

### pulls/list-reviews

`GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews`

List reviews for a pull request

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `pull_number` | path | integer | yes | The number that identifies the pull request. |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `pulls/list-reviews(owner: string, repo: string, pull_number: integer, per_page?: integer, page?: integer)`

## Tool `repos`

### repos/get

`GET /repos/{owner}/{repo}`

Get a repository

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |

Signature: `repos/get(owner: string, repo: string)`

### repos/list-for-user

`GET /users/{username}/repos`

List repositories for a user

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `username` | path | string | yes | The handle for the GitHub user account. |
| `type` | query | "all"\|"owner"\|"member" | no |  |
| `sort` | query | "created"\|"updated"\|"pushed"\|"full_name" | no |  |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `repos/list-for-user(username: string, type?: "all"|"owner"|"member", sort?: "created"|"updated"|"pushed"|"full_name", per_page?: integer, page?: integer)`

### repos/list-for-org

`GET /orgs/{org}/repos`

List organization repositories

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | The organization name. |
| `type` | query | "all"\|"public"\|"private"\|"forks"\|"sources"\|… | no |  |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `repos/list-for-org(org: string, type?: "all"|"public"|"private"|"forks"|"sources"|…, per_page?: integer, page?: integer)`

### repos/list-contributors

`GET /repos/{owner}/{repo}/contributors`

List repository contributors

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `repos/list-contributors(owner: string, repo: string, per_page?: integer, page?: integer)`

### repos/list-languages

`GET /repos/{owner}/{repo}/languages`

List repository languages

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |

Signature: `repos/list-languages(owner: string, repo: string)`

### repos/list-branches

`GET /repos/{owner}/{repo}/branches`

List branches

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `repos/list-branches(owner: string, repo: string, per_page?: integer, page?: integer)`

### repos/get-content

`GET /repos/{owner}/{repo}/contents/{path}`

Get repository content

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `path` | path | string | yes | Path of the file or directory |
| `ref` | query | string | no | The name of the commit |

Signature: `repos/get-content(owner: string, repo: string, path: string, ref?: string)`

### repos/list-commits

`GET /repos/{owner}/{repo}/commits`

List commits

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `sha` | query | string | no | SHA or branch to start listing commits from. |
| `path` | query | string | no | Only commits containing this file path. |
| `author` | query | string | no | GitHub username or email address. |
| `since` | query | string(date-time) | no |  |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `repos/list-commits(owner: string, repo: string, sha?: string, path?: string, author?: string, since?: string(date-time), per_page?: integer, page?: integer)`

### repos/get-commit

`GET /repos/{owner}/{repo}/commits/{ref}`

Get a commit

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `ref` | path | string | yes | Commit SHA |

Signature: `repos/get-commit(owner: string, repo: string, ref: string)`

### repos/list-releases

`GET /repos/{owner}/{repo}/releases`

List releases

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `repos/list-releases(owner: string, repo: string, per_page?: integer, page?: integer)`

### repos/get-latest-release

`GET /repos/{owner}/{repo}/releases/latest`

Get the latest release

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |

Signature: `repos/get-latest-release(owner: string, repo: string)`

## Tool `search`

### search/repos

`GET /search/repositories`

Search repositories

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `q` | query | string | yes | The query |
| `sort` | query | "stars"\|"forks"\|"help-wanted-issues"\|"updated" | no |  |
| `order` | query | "desc"\|"asc" | no |  |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `search/repos(q: string, sort?: "stars"|"forks"|"help-wanted-issues"|"updated", order?: "desc"|"asc", per_page?: integer, page?: integer)`

### search/issues-and-pull-requests

`GET /search/issues`

Search issues and pull requests

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `q` | query | string | yes | The query |
| `sort` | query | "comments"\|"reactions"\|"created"\|"updated" | no |  |
| `order` | query | "desc"\|"asc" | no |  |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `search/issues-and-pull-requests(q: string, sort?: "comments"|"reactions"|"created"|"updated", order?: "desc"|"asc", per_page?: integer, page?: integer)`

### search/code

`GET /search/code`

Search code

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `q` | query | string | yes | The query |
| `per_page` | query | integer | no | Results per page (max 100). |
| `page` | query | integer | no | Page number of the results to fetch. |

Signature: `search/code(q: string, per_page?: integer, page?: integer)`

## Tool `users`

### users/get-by-username

`GET /users/{username}`

Get a user

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `username` | path | string | yes | The handle for the GitHub user account. |

Signature: `users/get-by-username(username: string)`

### users/get-authenticated

`GET /user`

Get the authenticated user

No parameters.

Signature: `users/get-authenticated()`

## Blocked in the current mode

### repos/update

`PATCH /repos/{owner}/{repo}` (write)

Update a repository

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `body` | body | {description?: string, homepage?: string, private?: boolean, archived?: boolean, default_branch?: string} | no | application/json |

Signature: `repos/update(owner: string, repo: string, body?: {description?: string, homepage?: string, private?: boolean, archived?: boolean, default_branch?: string})`

### repos/delete

`DELETE /repos/{owner}/{repo}` (destructive)

Delete a repository

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |

Signature: `repos/delete(owner: string, repo: string)`

### repos/create-for-authenticated-user

`POST /user/repos` (write)

Create a repository for the authenticated user

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `body` | body | {name: string, description?: string, private?: boolean, auto_init?: boolean} | yes | application/json |

Signature: `repos/create-for-authenticated-user(body: {name: string, description?: string, private?: boolean, auto_init?: boolean})`

### issues/create

`POST /repos/{owner}/{repo}/issues` (write)

Create an issue

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `body` | body | {title: string, body?: string, labels?: string[], assignees?: string[]} | yes | application/json |

Signature: `issues/create(owner: string, repo: string, body: {title: string, body?: string, labels?: string[], assignees?: string[]})`

### issues/update

`PATCH /repos/{owner}/{repo}/issues/{issue_number}` (write)

Update an issue

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `issue_number` | path | integer | yes | The number that identifies the issue. |
| `body` | body | {title?: string, body?: string, state?: "open"\|"closed", state_reason?: "completed"\|"not_planned"\|"reopened"\|null, labels?: string[]} | no | application/json |

Signature: `issues/update(owner: string, repo: string, issue_number: integer, body?: {title?: string, body?: string, state?: "open"|"closed", state_reason?: "completed"|"not_planned"|"reopened"|null, labels?: string[]})`

### issues/create-comment

`POST /repos/{owner}/{repo}/issues/{issue_number}/comments` (write)

Create an issue comment

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `issue_number` | path | integer | yes | The number that identifies the issue. |
| `body` | body | {body: string} | yes | application/json |

Signature: `issues/create-comment(owner: string, repo: string, issue_number: integer, body: {body: string})`

### issues/add-labels

`POST /repos/{owner}/{repo}/issues/{issue_number}/labels` (write)

Add labels to an issue

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `issue_number` | path | integer | yes | The number that identifies the issue. |
| `body` | body | {labels?: string[]} | no | application/json |

Signature: `issues/add-labels(owner: string, repo: string, issue_number: integer, body?: {labels?: string[]})`

### issues/remove-label

`DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}` (destructive)

Remove a label from an issue

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `issue_number` | path | integer | yes | The number that identifies the issue. |
| `name` | path | string | yes |  |

Signature: `issues/remove-label(owner: string, repo: string, issue_number: integer, name: string)`

### issues/lock

`PUT /repos/{owner}/{repo}/issues/{issue_number}/lock` (write)

Lock an issue

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `issue_number` | path | integer | yes | The number that identifies the issue. |
| `body` | body | {lock_reason?: "off-topic"\|"too heated"\|"resolved"\|"spam"} | no | application/json |

Signature: `issues/lock(owner: string, repo: string, issue_number: integer, body?: {lock_reason?: "off-topic"|"too heated"|"resolved"|"spam"})`

### pulls/create

`POST /repos/{owner}/{repo}/pulls` (write)

Create a pull request

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `body` | body | {title?: string, head: string, base: string, body?: string, draft?: boolean} | yes | application/json |

Signature: `pulls/create(owner: string, repo: string, body: {title?: string, head: string, base: string, body?: string, draft?: boolean})`

### pulls/merge

`PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` (write)

Merge a pull request

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |
| `pull_number` | path | integer | yes | The number that identifies the pull request. |
| `body` | body | {commit_title?: string, merge_method?: "merge"\|"squash"\|"rebase"} | no | application/json |

Signature: `pulls/merge(owner: string, repo: string, pull_number: integer, body?: {commit_title?: string, merge_method?: "merge"|"squash"|"rebase"})`

### activity/star-repo-for-authenticated-user

`PUT /user/starred/{owner}/{repo}` (write)

Star a repository for the authenticated user

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |

Signature: `activity/star-repo-for-authenticated-user(owner: string, repo: string)`

### activity/unstar-repo-for-authenticated-user

`DELETE /user/starred/{owner}/{repo}` (destructive)

Unstar a repository for the authenticated user

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `owner` | path | string | yes | The account owner of the repository. Not case sensitive. |
| `repo` | path | string | yes | The name of the repository without the .git extension. |

Signature: `activity/unstar-repo-for-authenticated-user(owner: string, repo: string)`
