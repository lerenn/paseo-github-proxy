GitHub proxy routes every agent's GitHub access through the daemon. Agents get no GitHub token. They call injected tools instead, and the daemon makes the request with a token it holds, so all agents on a host share one rate-limit budget per token instead of exhausting it independently.

Responses are cached with conditional requests, so repeated reads of the same pull request or check run cost little or nothing against the limit. Requests have priorities, and the plugin backs off on both primary and secondary rate limits.

When an agent is created, the plugin removes `GH_TOKEN`, `GITHUB_TOKEN` and any GitHub MCP server from its configuration, denies the real `gh` command, and adds the proxy's MCP tools plus a `gh`-compatible command for reads such as `gh pr view`, `gh pr checks` and `gh api`. To keep normal GitHub access for one agent, create it with `PASEO_GITHUB_PROXY=off` in its environment.

Agents can also subscribe to events, for example checks finished on a pull request, a review submitted, a merge, or a new comment, with a timeout. The plugin sends the agent a prompt when the event or the timeout arrives. Events come from GitHub's webhook forwarder over an outbound websocket, with slow polling as a safety net.

## Setup

Open the GitHub proxy screen and add one token per GitHub owner or organization, for example `anyshift-io`. Tokens are write-only: the screen shows whether one is set but never displays it. They are stored on the daemon machine in a file readable only by its user. The screen also shows the remaining budget for each token.

The webhook forwarder needs admin rights on the repository or organization, and GitHub allows one forwarder per repository. Without it, subscriptions rely on polling alone and are slower.

## Writes

Comments, pull request creation, labels and review requests are allowed. Merges and administrative calls are refused unless a repository policy allows them. Policies are per repository, as allow and deny lists, so you can for example forbid merging in one repository only. Refused writes never reach GitHub and are recorded in an audit list.

## Limits

Git clone and push are not proxied. Agents keep using SSH for those. The lockout is a default, not a sandbox: an agent with shell access that has its own credentials elsewhere on the machine can still use them.
