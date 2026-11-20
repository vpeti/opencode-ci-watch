import { Plugin, usePlugin } from "@opencode/plugin/tui"

// PROTOTYPE: mocked watcher state. Replace with an RPC call to the server part once
// the look is settled. Nothing here talks to GitHub.
type CheckState = "pass" | "fail" | "run" | "queue" | "skip"

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

const DOT: Record<CheckState, string> = {
  pass: "●",
  fail: "●",
  run: "●",
  queue: "○",
  skip: "○",
}

const LABEL: Record<CheckState, string> = {
  pass: "pass",
  fail: "fail",
  run: "run",
  queue: "queue",
  skip: "skip",
}

function tone(context: ReturnType<typeof usePlugin>, state: CheckState) {
  const feedback = context.theme.text.feedback
  if (state === "pass") return feedback.success.base
  if (state === "fail") return feedback.error.base
  if (state === "run") return feedback.warning.base
  if (state === "queue") return feedback.info.base
  return context.theme.text.faint
}

function overall(watch: Watch): CheckState {
  if (watch.checks.some((check) => check.state === "fail")) return "fail"
  if (watch.checks.some((check) => check.state === "run" || check.state === "queue")) return "run"
  return "pass"
}

function summary(watch: Watch): string {
  const passed = watch.checks.filter((check) => check.state === "pass").length
  const failed = watch.checks.filter((check) => check.state === "fail").length
  const running = watch.checks.filter((check) => check.state === "run" || check.state === "queue").length
  const parts = [`${passed}/${watch.checks.length}`]
  if (failed > 0) parts.push(`${failed} fail`)
  if (running > 0) parts.push(`${running} run`)
  return parts.join(" · ")
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`
}

function WatchLine(props: { watch: Watch; showRun?: boolean }) {
  const context = usePlugin()
  return (
    <box flexDirection="row">
      <text fg={tone(context, overall(props.watch))}>{DOT[overall(props.watch)]} </text>
      <text fg={context.theme.text.base}>{props.watch.branch}</text>
      <text fg={context.theme.text.muted}>  {summary(props.watch)}</text>
      {props.showRun ? <text fg={context.theme.text.faint}>  run {props.watch.run}</text> : null}
    </box>
  )
}

function CheckLine(props: { check: Check; indent?: number; detail?: boolean }) {
  const context = usePlugin()
  return (
    <box flexDirection="row" paddingLeft={props.indent ?? 0}>
      <text fg={tone(context, props.check.state)}>{DOT[props.check.state]} </text>
      <text fg={context.theme.text.base}>{pad(props.check.name, props.detail ? 16 : 12)}</text>
      <text fg={tone(context, props.check.state)}>{pad(LABEL[props.check.state], 6)}</text>
      {props.detail ? <text fg={context.theme.text.faint}>{props.check.duration ?? ""}</text> : null}
    </box>
  )
}

function Sidebar() {
  const context = usePlugin()
  return (
    <box flexDirection="column" paddingLeft={1}>
      <text fg={context.theme.text.muted}>CI</text>
      {WATCHES.map((watch) => {
        const attention = watch.checks.filter((check) => check.state === "fail" || check.state === "run")
        // Few checks: list them all. Many: only the ones that need attention.
        const listed = watch.checks.length <= 5 ? watch.checks : attention
        return (
          <box flexDirection="column">
            <WatchLine watch={watch} />
            {listed.slice(0, 4).map((check) => (
              <CheckLine check={check} indent={2} />
            ))}
            {listed.length > 4 ? <text fg={context.theme.text.faint}>  … {listed.length - 4} more</text> : null}
          </box>
        )
      })}
    </box>
  )
}

function Panel() {
  const context = usePlugin()
  return (
    <box flexDirection="column" padding={1}>
      <box flexDirection="row">
        <text fg={context.theme.text.base}>CI</text>
        <text fg={context.theme.text.muted}>  watched checks</text>
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
