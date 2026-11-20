import { Plugin, usePlugin } from "@opencode/plugin/tui"

// PROTOTYPE: mocked watcher state. Replace with an RPC call to the server part once
// the look is settled. Nothing here talks to GitHub.
type CheckState = "pass" | "fail" | "run" | "queue" | "skip" | "cancel" | "neutral"

interface Check {
  name: string
  state: CheckState
  duration?: string
}

interface Watch {
  branch: string
  run: number
  checks: Check[]
}

const WATCHES: Watch[] = [
  {
    branch: "main",
    run: 44706868699,
    checks: [
      { name: "fmt", state: "pass", duration: "11s" },
      { name: "deny", state: "pass", duration: "48s" },
      { name: "model", state: "pass", duration: "10s" },
      { name: "provenance", state: "pass", duration: "8s" },
      { name: "clippy", state: "fail", duration: "21s" },
      { name: "test", state: "run", duration: "2m" },
      { name: "aarch64", state: "queue" },
      { name: "bench", state: "skip" },
    ],
  },
  {
    branch: "feature/login",
    run: 44705162783,
    checks: [
      { name: "fmt", state: "pass", duration: "9s" },
      { name: "test", state: "pass", duration: "2m17s" },
    ],
  },
]

// One state table drives the summary glyphs, the list rows and the panel, so a new
// conclusion only has to be added here. Glyphs follow the GitHub checks UI.
const STATE: Record<CheckState, { dot: string; label: string; tone: "success" | "error" | "warning" | "muted" | "faint" }> = {
  pass: { dot: "●", label: "passed", tone: "success" },
  fail: { dot: "●", label: "failed", tone: "error" },
  run: { dot: "●", label: "running", tone: "warning" },
  queue: { dot: "○", label: "queued", tone: "warning" },
  skip: { dot: "○", label: "skipped", tone: "faint" },
  cancel: { dot: "●", label: "cancelled", tone: "muted" },
  neutral: { dot: "●", label: "neutral", tone: "muted" },
}

function tone(context: ReturnType<typeof usePlugin>, state: CheckState) {
  const kind = STATE[state].tone
  if (kind === "success") return context.theme.text.feedback.success.base
  if (kind === "error") return context.theme.text.feedback.error.base
  if (kind === "warning") return context.theme.text.feedback.warning.base
  if (kind === "faint") return context.theme.text.faint
  return context.theme.text.muted
}

function overall(watch: Watch): CheckState {
  if (watch.checks.some((check) => check.state === "fail")) return "fail"
  if (watch.checks.some((check) => check.state === "run" || check.state === "queue")) return "run"
  return "pass"
}

function counts(watch: Watch) {
  const value = {
    total: watch.checks.length,
    passed: 0,
    failed: 0,
    running: 0,
    queued: 0,
    skipped: 0,
    other: 0,
  }
  for (const check of watch.checks) {
    if (check.state === "pass") value.passed += 1
    else if (check.state === "fail") value.failed += 1
    else if (check.state === "run") value.running += 1
    else if (check.state === "queue") value.queued += 1
    else if (check.state === "skip") value.skipped += 1
    else value.other += 1
  }
  return value
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`
}

function StatusCounts(props: { watch: Watch }) {
  const context = usePlugin()
  const value = counts(props.watch)
  const cells = [
    { show: true, dot: STATE.pass.dot, text: `${value.passed}/${value.total}`, color: tone(context, "pass") },
    { show: value.failed > 0, dot: STATE.fail.dot, text: String(value.failed), color: tone(context, "fail") },
    { show: value.running > 0, dot: STATE.run.dot, text: String(value.running), color: tone(context, "run") },
    { show: value.queued > 0, dot: STATE.queue.dot, text: String(value.queued), color: tone(context, "queue") },
    { show: value.skipped > 0, dot: STATE.skip.dot, text: String(value.skipped), color: tone(context, "skip") },
    { show: value.other > 0, dot: STATE.neutral.dot, text: String(value.other), color: tone(context, "neutral") },
  ]
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      {cells
        .filter((cell) => cell.show)
        .map((cell) => (
          <text wrapMode="none">
            <span style={{ fg: cell.color }}>{cell.dot}</span>
            <span style={{ fg: context.theme.text.muted }}> {cell.text}</span>
          </text>
        ))}
    </box>
  )
}

function WatchLine(props: { watch: Watch; showRun?: boolean }) {
  const context = usePlugin()
  return (
    <box flexDirection="row" gap={1} minWidth={0}>
      <text fg={context.theme.text.base} wrapMode="none" truncate flexShrink={1} minWidth={0}>
        <b>{props.watch.branch}</b>
      </text>
      <StatusCounts watch={props.watch} />
      {props.showRun ? (
        <text fg={context.theme.text.faint} wrapMode="none" flexShrink={0}>
          run {props.watch.run}
        </text>
      ) : null}
    </box>
  )
}

function CheckLine(props: { check: Check; indent?: number; detail?: boolean }) {
  const context = usePlugin()
  return (
    <box
      flexDirection="row"
      paddingLeft={props.indent ?? 0}
      minWidth={0}
      onMouseUp={() => {
        context.ui.panel.open("ci")
      }}
    >
      <text fg={tone(context, props.check.state)}>{STATE[props.check.state].dot} </text>
      <text fg={context.theme.text.base}>{pad(props.check.name, props.detail ? 16 : 12)}</text>
      <text fg={tone(context, props.check.state)}>{pad(STATE[props.check.state].label, props.detail ? 10 : 8)}</text>
      {props.detail ? <text fg={context.theme.text.faint}>{props.check.duration ?? ""}</text> : null}
    </box>
  )
}

function Sidebar() {
  const context = usePlugin()
  const [view, updateView] = context.storage.store("view", { initial: { open: true } })
  const failed = WATCHES.filter((watch) => overall(watch) === "fail").length

  return (
    <box flexDirection="column">
      <box
        flexDirection="row"
        gap={1}
        onMouseDown={() => {
          void updateView((draft) => {
            draft.open = !draft.open
          }).catch((error) => console.error("Failed to persist CI sidebar state", error))
        }}
      >
        <text fg={context.theme.text.base}>{view.open ? "▼" : "▶"}</text>
        <text fg={context.theme.text.base}>
          <b>CI</b>
        </text>
        {view.open ? null : (
          <text fg={context.theme.text.muted}>
            ({WATCHES.length} watched{failed > 0 ? `, ${failed} failed` : ""})
          </text>
        )}
      </box>
      {view.open
        ? WATCHES.map((watch) => {
            const attention = watch.checks.filter((check) => check.state === "fail" || check.state === "run")
            // Few checks: list them all. Many: only the ones that need attention.
            const listed = watch.checks.length <= 5 ? watch.checks : attention
            return (
              <box flexDirection="column">
                <WatchLine watch={watch} />
                {listed.slice(0, 4).map((check) => (
                  <CheckLine check={check} indent={2} />
                ))}
                {listed.length > 4 ? (
                  <text fg={context.theme.text.faint}>  … {listed.length - 4} more</text>
                ) : null}
              </box>
            )
          })
        : null}
    </box>
  )
}

function Panel() {
  const context = usePlugin()
  return (
    <box flexDirection="column" padding={1}>
      <box flexDirection="row" gap={1}>
        <text fg={context.theme.text.base}>
          <b>CI</b>
        </text>
        <text fg={context.theme.text.muted}>watched checks</text>
      </box>
      {WATCHES.map((watch) => (
        <box flexDirection="column" marginTop={1}>
          <WatchLine watch={watch} showRun />
          {watch.checks.map((check) => (
            <CheckLine check={check} indent={2} detail />
          ))}
        </box>
      ))}
      <text fg={context.theme.text.faint}>esc closes · ctrl+f fullscreen</text>
    </box>
  )
}

export default Plugin.define({
  id: "ci",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: () => <Sidebar />,
    })
    context.ui.slot({
      append: "session.panel",
      render: (input) => (input.name === "ci" ? <Panel /> : <></>),
    })
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "ci.panel",
          title: "CI: watched checks",
          group: "CI",
          palette: true,
          slash: { name: "ci" },
          enabled: () => true,
          run: () => {
            context.ui.panel.open("ci")
          },
        },
      ],
    }))
  },
})
