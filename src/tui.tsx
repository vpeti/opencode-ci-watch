import { createMemo, createSignal } from "solid-js"
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

const BASE: Watch[] = [
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
  const feedback = context.theme.text.feedback
  if (state === "run") return pulse() ? feedback.warning.base : feedback.warning.muted
  if (state === "pass") return feedback.success.base
  if (state === "fail") return feedback.error.base
  if (state === "queue") return feedback.warning.base
  if (state === "skip") return context.theme.text.faint
  return context.theme.text.muted
}

// Demo clock: one state transition every 700ms, then a short hold and a reset.
const initial = (): Watch[] =>
  BASE.map((watch, index) => ({
    ...watch,
    checks: watch.checks.map((check) =>
      index === 0
        ? { ...check, state: check.state === "skip" ? "skip" : "queue", duration: undefined }
        : { ...check },
    ),
  }))

const [demo, setDemo] = createSignal<Watch[]>(initial())
const [pulse, setPulse] = createSignal(0)

function transition(watches: Watch[], name: string, state: CheckState, duration?: string): Watch[] {
  return watches.map((watch, index) =>
    index !== 0
      ? watch
      : {
          ...watch,
          checks: watch.checks.map((check) => (check.name === name ? { ...check, state, duration } : check)),
        },
  )
}

const STEP = (name: string, state: CheckState, duration?: string) => () =>
  setDemo((watches) => transition(watches, name, state, duration))

const STEPS = [
  STEP("fmt", "run"),
  STEP("fmt", "pass", "11s"),
  STEP("deny", "run"),
  STEP("deny", "pass", "48s"),
  STEP("model", "run"),
  STEP("model", "pass", "10s"),
  STEP("provenance", "run"),
  STEP("provenance", "pass", "8s"),
  STEP("clippy", "run"),
  STEP("clippy", "fail", "21s"),
  STEP("test", "run"),
  STEP("test", "pass", "2m17s"),
  STEP("aarch64", "run"),
  STEP("aarch64", "pass", "1m04s"),
  STEP("clippy", "run"),
  STEP("clippy", "pass", "35s"),
]

type Overall = "waiting" | "running" | "done" | "failed"

// One overall dot per watched branch: empty orange while waiting, filled orange
// while running, green when everything finished, red as soon as something failed.
const OVERALL: Record<Overall, { dot: string; tone: CheckState }> = {
  waiting: { dot: "○", tone: "queue" },
  running: { dot: "●", tone: "run" },
  done: { dot: "●", tone: "pass" },
  failed: { dot: "●", tone: "fail" },
}

function overall(watch: Watch): Overall {
  const value = counts(watch)
  if (value.failed > 0) return "failed"
  if (value.running > 0) return "running"
  if (value.queued > 0) return "waiting"
  return "done"
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

function WatchLine(props: { watch: Watch }) {
  const context = usePlugin()
  const state = overall(props.watch)
  return (
    <box flexDirection="row" gap={1} minWidth={0}>
      <text fg={tone(context, OVERALL[state].tone)}>{OVERALL[state].dot}</text>
      <text fg={context.theme.text.base} wrapMode="none" truncate flexShrink={1} minWidth={0}>
        <b>{props.watch.branch}</b>
      </text>
    </box>
  )
}

function CheckLine(props: { check: Check }) {
  const context = usePlugin()
  return (
    <box flexDirection="row" gap={1} minWidth={0}>
      <text fg={tone(context, props.check.state)} flexShrink={0}>
        {STATE[props.check.state].dot}
      </text>
      <text fg={context.theme.text.muted} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
        {props.check.name}
      </text>
      <text fg={tone(context, props.check.state)} flexShrink={0}>
        {STATE[props.check.state].label}
      </text>
    </box>
  )
}

function Sidebar() {
  const context = usePlugin()
  const [view, updateView] = context.storage.store("view", { initial: { open: true } })
  const watches = demo
  const failed = createMemo(() => watches().filter((watch) => overall(watch) === "failed").length)

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
            ({watches().length} watched{failed() > 0 ? `, ${failed()} failed` : ""})
          </text>
        )}
      </box>
      {view.open
        ? watches().map((watch) => (
            <box flexDirection="column">
              <WatchLine watch={watch} />
              {watch.checks.map((check) => (
                <CheckLine check={check} />
              ))}
            </box>
          ))
        : null}
    </box>
  )
}

export default Plugin.define({
  id: "ci",
  setup(context) {
    const stopTicks = context.renderer.onAnimationTick(4, (_delta, ticks) => setPulse(ticks % 2))
    let cursor = 0
    let hold = 0
    const timer = setInterval(() => {
      if (cursor < STEPS.length) {
        STEPS[cursor]!()
        cursor += 1
        return
      }
      hold += 1
      if (hold > 4) {
        hold = 0
        cursor = 0
        setDemo(initial())
      }
    }, 700)
    context.ui.slot({
      append: "sidebar.content",
      render: () => <Sidebar />,
    })
    return () => {
      stopTicks()
      clearInterval(timer)
    }
  },
})
