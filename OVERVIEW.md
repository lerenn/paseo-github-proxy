GitHub Proxy gives every agent the same small set of `github_*` tools for working with GitHub, and puts your rules, a shared cache and rate-limit handling between the agents and GitHub.

Agents list and read pull requests, issues, commits, files, checks, releases, workflow runs and logs, labels, projects, secret names, rulesets and repositories, search, and, when you allow it, comment, review, open issues and pull requests, edit and label them, create branches, write files, manage releases and workflow runs, merge, and delete branches. Each group of `gh` commands has a typed tool with its own policy action, and secret values are never read or set. A generic `github_api` tool (REST and GraphQL) covers the rest, and is only usable where the policy allows it.

## How it works

The tools run inside the Paseo daemon and are added to every agent when its session opens. Each call is checked in this order: the allowed owners list, then the policy, then the cache. Reads younger than the cache lifetime (30 seconds by default) are answered locally. Older reads are revalidated with the saved ETag, which costs no rate limit when nothing changed. The cache is also saved on disk, so it survives a restart. When GitHub rate limits the active credentials, the agent gets a clear "retry at HH:MM" error, or a stale cached answer where one exists.

A denied call returns a message that names the rule and the reason, so the agent stops retrying.

## Setup

Open GitHub Proxy from the sidebar.

- Auth: pick the local `gh` CLI (it must be logged in on the daemon machine) or one or several GitHub Apps (the organization or user it is installed on, App ID, installation ID, private key and optional extra owners). Each App has its own rate limit, shown in Overview. The private keys are stored in a file on the daemon machine that only its user can read, and is never sent back to the app. An option falls back to the other source when the active one is rate limited.
- Allowed owners: check the GitHub users and organizations agents may reach in a dropdown filled from the active source (every App is asked). The default is `*` (every owner); replace it to restrict agents. An empty list refuses every call.
- Policy: a fresh install starts on the Full preset (every action allowed). Switch to Read-only or the PR workflow preset in one tap, or check individual actions in a dropdown, and add allow or deny rules per repository pattern. Test connection on each GitHub App checks the key, App ID, installation and token step by step and explains any failure. A test box shows what the policy would say about a call without sending anything.

An optional setting adds an instruction to every agent's system prompt and tool descriptions to use these tools instead of `gh` or `curl`. It is a soft rule: an agent with a shell can still run `gh`.

A second, optional setting (the hard rule) denies permission requests for shell commands that run `gh`, or `curl` or `wget` against GitHub, and tells the agent to use these tools. It only applies when the agent asks for permission (an agent in a bypass mode never does) and it matches command text, so it is not a sandbox. A real block needs network rules on the machine that runs the daemon.

## Webhooks and wake-ups

Optional and off by default. Turn on the webhook listener in Auth, give each GitHub App a generated webhook secret, and point GitHub at it through a public URL that you provide (a tunnel or reverse proxy such as cloudflared). Subscribe the App to the check_run, check_suite, issue_comment, merge_group, pull_request, pull_request_review, pull_request_review_comment, push, release, status and workflow_run events. Verified events refresh the cache at once, and agents can ask to be woken when checks finish (on a pull request, a commit, a branch or a tag), a review or comment arrives (optionally mentioning a handle), a pull request or merge queue group is merged or closed, a branch or tag is pushed or a release is published (`github_subscribe`, policy action Subscribe to events, off in the Read-only preset).

## Good to know

- Needs Paseo 0.16.2 or later.
- The activity log and counters are kept in memory and reset when the plugin restarts. Settings and the cache persist.
- GraphQL calls are checked against the repository you pass and any `owner:` values in the query. Queries by node ID cannot be scoped to an owner, so they are refused unless every owner is allowed.
- The soft rule reaches an agent in its system prompt when the agent is created (on Paseo 0.17 and later also when a session opens), so agents created before you turned it on do not get it on Paseo 0.16. It tells agents the github_* tools take precedence over a project file that allows gh, unless you ask for gh.
