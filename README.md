# opencode-ci-watch

An [OpenCode](https://opencode.ai) v2 plugin that turns GitHub Actions events into agent context.

Agents watch CI on a branch, commit, or run. A failure wakes the session with the failing job and a
trimmed log excerpt. A green run only updates a short status line. Nothing polls `gh` in a loop and
no webhook exists while nobody is watching.

```
⤴️ main · a1b2c3d · 3 commits · alice "fix: retry backoff"
❌ ci feature/login · r123457 · 2/3 jobs failed (test, lint) · 1m12s
✗ test/ubuntu-latest · step "cargo test"
  error[E0308]: mismatched types --> src/db.rs:88
↳ gh run view 123457 --log-failed
```

## Requirements

- OpenCode v2 (server plugin API, `@opencode/plugin` 2.x)
- Node 20+ in the OpenCode server
- [`gh`](https://cli.github.com) logged in with access to the repository
- the webhook extension: `gh extension install cli/gh-webhook`
- a `github.com` remote (`origin`) and permission to create dev webhooks on the repo

GitHub Enterprise is not supported.

## Install

```sh
# while the package is not on npm, point OpenCode at the checkout
```

```jsonc title="~/.config/opencode/opencode.jsonc"
{
  "plugins": [
    {
      "package": "/path/to/opencode-ci-watch",
      "options": {
        "account": "your-gh-login"
      }
    }
  ]
}
```

`account` is only needed when several `gh` accounts are logged in. The plugin never calls
`gh auth switch`: it reads that account's token with `gh auth token --user` and passes it to its
child processes.

## Configure per repository

`.opencode/ci-watch.json` in the repository, read when the plugin loads for that working copy:

```jsonc
{
  "repo": "owner/name",                 // default: resolved from the git remote
  "account": "your-gh-login",           // default: user-level option
  "autoSubscribe": { "onPush": false }, // opt-in: watch the branch after `git push`
  "notify": { "success": true },        // all-green wakes the agent; false: status line only
  "maxLogChars": 1200,
  "agents": {
    "*": { "tools": "read" },           // ci_status + ci_log everywhere
    "build": { "tools": "all" },        // the implementation agent may watch and wait
    "plan": false                       // no ci tools, no note
  }
}
```

`agents` is applied through the agent transform: `all` exposes every tool, `read` only `ci_status`/`ci_log`,
`none` denies all five, and the plugin appends a short usage note to the agent's system prompt unless
`"instructions": false` or a custom string is given. The note and the permissions are recomputed on every
plugin load, so they never stack up.

OpenCode reads this file when the plugin loads, so **restart OpenCode (or reload the plugin) after
changing it**. Editing a plugin source file reloads it automatically; this config file does not.

Environment overrides for scripted use: `CI_WATCH_REPO`, `CI_WATCH_ACCOUNT`, `CI_WATCH_DISABLE`.

## Tools

Namespace `ci`. All targets accept exactly one of `branch`, `sha`, `run`, `current`; omitting them
uses the current branch.

| Tool | Use |
| --- | --- |
| `ci_watch` | Subscribe this session to a branch, commit, or run. `include: ["pushes"]` reports every push (merges on `main`). |
| `ci_unwatch` | Remove one subscription, one target, or all of this session's subscriptions. |
| `ci_status` | Deliberate snapshot: latest runs, `include: ["jobs"]`, `include: ["logs"]`. |
| `ci_wait` | Block until a result exists (default 300s, max 900s). |
| `ci_log` | More of the failing log for a run or job. |

How delivery works:

- **failure** → synthetic message, waking an idle session (queued after the current step by
  default; `delivery: "steer"` injects into it)
- **success** → one synthetic message once every run on the commit is green, the signal that the
  work is done; `notify: "failures"` turns it into a status-line-only update
- **push** → synthetic message, only for subscriptions with `include: ["pushes"]`
- **forwarder broken** → one warning in the status line

Subscriptions live in plugin storage, survive restarts, and expire after 24 hours by default.
They are per session, so an orchestrator and a subagent can watch different targets.

## Transport

On the first subscription the plugin starts a loopback HTTP server, then spawns
`gh webhook forward` for `push` and `workflow_run` with a per-process HMAC secret. GitHub's dev
webhook is active only while that process runs. With no subscriptions the forwarder stops after an
idle period and nothing is left on the repository.

`gh webhook forward` needs the account to be allowed to create dev webhooks. If it returns 403, the
plugin says so instead of retrying forever; `ci_status` keeps working through the GitHub API.

## Agent guidance

The plugin ships a `CI Watch` skill with the generic "when and how" rules. Repository-level policy
belongs in your own instructions:

```md
After `git push`, watch the current branch with `ci_watch`; use `ci_wait` only when you cannot
continue. Orchestrator: watch `main` with `include: ["pushes"]` and follow only the merges that
belong to your work.
```

## Develop

```sh
npm install
npm run typecheck
npm test
```

Tests execute the `.ts` sources directly through Node's type stripping, so development needs
**Node 24+**; the plugin itself only needs Node 20 when OpenCode loads it. There is no bundler or
test transpiler in the dependency tree.

`PLAN.md` is intentionally not tracked; it is a local design document.

## Server RPC

The server forwards `workflow_job` and `pull_request`, caches job state in workflow order, resolves
the default branch, and exposes:

- `ci.state({ sessionID })` → `{ defaultBranch, watches }` with the latest run, jobs and timestamps;
- `ci.updated({ sessionID })` after a run, job, merge or subscription change.

## TUI

`src/tui.tsx` renders a live CI section in the sidebar from `ci.state`:

- one row per branch subscription, with the default branch pinned first;
- an overall state dot (waiting/running/done/failed) and, once running, the workflow timer;
- every check with a grey name, a spinner while running, a timer and a right-aligned state label;
- merged branches turn purple, drop their jobs, and stay until the subscription ends;
- all-green branches collapse their jobs after five seconds but keep the row.

The section refreshes from the `ci.updated` RPC event, shows a short `CI no watches` state when
nothing is subscribed, and stays hidden when the server plugin is unavailable.
