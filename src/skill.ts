export const SKILL_ID = "ci-watch"
export const SKILL_NAME = "CI Watch"

export const SKILL_DESCRIPTION =
  "Watch GitHub Actions for a branch, commit or run instead of polling gh. Use after pushing, when you need " +
  "CI results, or when coordinating merges on main."

export const SKILL_PATH = "/opencode-ci-watch/SKILL.md"

export const SKILL_CONTENT = `# Watching GitHub Actions

The \`ci\` tools deliver CI events into this session. Do not poll \`gh run list\`, \`gh pr checks\` or
\`ci_status\` in a loop.

## After pushing

Call \`ci_watch\` with \`current: true\` (or the pushed branch). Then keep working. A failed run wakes
you with the failing job, the step and a short log excerpt. Depending on the repository and the
subscription, an all-green run also wakes you; that message means the work is done and it is time
to finish. Use \`notify: "failures"\` when a green result should not interrupt you.

## When you must have the result before continuing

\`ci_wait\` on the branch, commit or run. It blocks up to 900 seconds and returns the same compact
summary. Do not use it for work you can do in parallel.

## Reading the summary

- \`✅\` success, \`❌\` failure, \`⏱️\` timed out, \`⊘\` cancelled, \`⏭️\` skipped, \`⏳\` running
- \`r<number>\` is the workflow run id; use \`ci_log\` with it for more of the failing log.
- The status line in \`<context key="ci">\` lists what this session watches and the latest result.

## Orchestrating merges on main

Watch the branch with \`include: ["pushes"]\`. Every push (a merge is a push) arrives as
\`⤴️ main · <sha> · N commits · author "message"\`. Decide whether that merge matters to you, and only
then watch \`sha\` to follow its workflow runs. Ignore the rest; nothing is subscribed automatically.

## Cleanup

\`ci_unwatch\` with \`all: true\` when a branch no longer matters. Subscriptions expire after 24
hours by default.
`
