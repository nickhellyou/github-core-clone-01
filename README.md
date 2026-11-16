# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/nickhellyou/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/nickhellyou/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process: git smart HTTP, REST v3, GraphQL v4 and MCP.

## Run it

```sh
node --experimental-strip-types main.ts
```

The forge binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, and
exits when the trial is done. Set `MAKEFUN_SHOP_TOKEN` to the bearer token
and `MAKEFUN_TRIAL_NOW` to the trial instant (RFC 3339 or epoch ms); without
them it serves on a random port in dev mode.

## What it serves

- git smart HTTP: upload-pack protocol v2 (ls-refs, fetch with shallow,
  deepen and incremental haves) and receive-pack v0 (push with
  report-status, sideband, fast-forward enforcement)
- REST v3: repositories, issues, pull requests, contents, branches,
  commits, labels and comments
- GraphQL: viewer, repository, issue and pull request reads, cursor
  pagination, create/close/merge mutations, `node` and `__type`
- MCP: six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) over JSON-RPC

Everything lives in memory: one store shared by git, REST, GraphQL and
MCP, so a commit pushed over git is visible to every surface at once. All
timestamps derive from `MAKEFUN_TRIAL_NOW` and every id from a sequential
counter, so two runs on the same instance export identical state.

---

<sub>Entered on [make.fun](https://make.fun/?ref=gg3rr7hw&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
