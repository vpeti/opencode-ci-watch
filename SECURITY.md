# Security policy

## Supported versions

The latest published version of `opencode-ci-watch` is supported. Fixes land on `main` and are
released as patch versions.

## Reporting a vulnerability

Please use the repository's **Security → Advisories → Report a vulnerability** page (GitHub
private vulnerability reporting).

Do not open a public issue for a security problem. Include reproduction steps and the affected
version. You can expect an acknowledgement within a few days.

## What this plugin touches

Worth knowing when reviewing a report:

- **GitHub token**: it reads the token of the configured `gh` account with `gh auth token --user`
  and passes it only through the environment of its child processes. It never writes the token to
  storage or logs, and it never runs `gh auth switch`.
- **Local listener**: an HTTP server bound to `127.0.0.1` on an ephemeral port, with a
  per-process HMAC secret generated with `node:crypto`. It verifies `X-Hub-Signature-256` and
  deduplicates `X-GitHub-Delivery`.
- **Repository webhook**: `gh webhook forward` creates a temporary dev webhook while at least one
  subscription is active. The plugin deletes that hook when the forwarder stops.
- **Session content**: notifications contain repository-derived text (branch, commit subject,
  job and step names, a trimmed log excerpt). ANSI escapes are stripped and output is capped.
- **Storage**: subscriptions only (session id, target, mode, timestamps) in OpenCode plugin
  storage. No tokens, no logs.
