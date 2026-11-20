import { createMemo, createSignal } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"

// PROTOTYPE: mocked watcher state. Replace with an RPC call to the server part once
// the look is settled. Nothing here talks to GitHub.
type CheckState = "pass" | "fail" | "run" | "queue" | "skip" | "cancel" | "neutral"

interface Check {
  name: string
  state: CheckState
  duration?: string
  since?: number
}

interface Watch {
  branch: string
  run: number
  checks: Check[]
  startedAt?: number
  finishedAt?: number
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
  pass: { dot: "●", label: "Passed", tone: "success" },
  fail: { dot: "●", label: "Failed", tone: "error" },
  run: { dot: "●", label: "Running", tone: "warning" },
  queue: { dot: "○", label: "Queued", tone: "warning" },
  skip: { dot: "○", label: "Skipped", tone: "faint" },
  cancel: { dot: "●", label: "Cancelled", tone: "muted" },
  neutral: { dot: "●", label: "Neutral", tone: "muted" },
}

function tone(context: ReturnType<typeof usePlugin>, state: CheckState) {
  const feedback = context.theme.text.feedback
  if (state === "run") return feedback.warning.base
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

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

const [demo, setDemo] = createSignal<Watch[]>(initial())
const [frame, setFrame] = createSignal(0)
const [now, setNow] = createSignal(Date.now())

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const tail = `${minutes}:${String(seconds).padStart(2, "0")}`
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : tail
}

function elapsed(watch: Watch, at: number): string | undefined {
  if (!watch.startedAt) return undefined
  return clock((watch.finishedAt ?? at) - watch.startedAt)
}

type Change = [name: string, state: CheckState, duration?: string]

function apply(watches: Watch[], changes: Change[]): Watch[] {
  const at = Date.now()
  return watches.map((watch, index) => {
    if (index !== 0) return watch
    let checks = watch.checks
    for (const [name, state, duration] of changes) {
      checks = checks.map((check) =>
        check.name === name
          ? { ...check, state, duration, since: state === "run" ? (check.since ?? at) : undefined }
          : check,
      )
    }
    const running = checks.some((check) => check.state === "run")
    const pending = checks.some((check) => check.state === "run" || check.state === "queue")
    const startedAt = watch.startedAt ?? (running ? at : undefined)
    const finishedAt = watch.finishedAt ?? (startedAt !== undefined && !pending ? at : undefined)
    return { ...watch, checks, startedAt, finishedAt }
  })
}

const STEP = (...changes: Change[]) => () => setDemo((watches) => apply(watches, changes))

// Jobs start in parallel, like a real workflow: enough running time for the
// per-job counters to climb, and the retry lets the cycle end all-green.
const STEPS = [
  STEP(
    ["fmt", "run"],
    ["deny", "run"],
    ["model", "run"],
    ["provenance", "run"],
    ["test", "run"],
    ["aarch64", "run"],
  ),
  STEP(
    ["fmt", "pass", "11s"],
    ["deny", "pass", "48s"],
    ["model", "pass", "10s"],
    ["provenance", "pass", "8s"],
    ["clippy", "run"],
  ),
  STEP(["clippy", "fail", "21s"]),
  STEP(["test", "pass", "2m17s"], ["aarch64", "pass", "1m04s"], ["clippy", "run"]),
  STEP(["clippy", "pass", "35s"]),
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
  const time = createMemo(() => elapsed(props.watch, now()))
  return (
    <box flexDirection="row" gap={1} minWidth={0}>
      <text fg={tone(context, OVERALL[state].tone)} flexShrink={0}>
        {OVERALL[state].dot}
      </text>
      <text fg={context.theme.text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
        <b>{props.watch.branch}</b>
      </text>
      {time() ? (
        <text fg={context.theme.text.muted} flexShrink={0}>
          {time()}
        </text>
      ) : null}
    </box>
  )
}

function CheckLine(props: { check: Check }) {
  const context = usePlugin()
  const time = createMemo(() =>
    props.check.state === "run" && props.check.since ? clock(now() - props.check.since) : undefined,
  )
  return (
    <box flexDirection="row" gap={1} minWidth={0}>
      <text fg={tone(context, props.check.state)} flexShrink={0}>
        {props.check.state === "run" ? SPINNER[frame() % SPINNER.length] : STATE[props.check.state].dot}
      </text>
      <text fg={context.theme.text.muted} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
        {props.check.name}
      </text>
      <box flexDirection="row" gap={1} flexShrink={0}>
        {time() ? <text fg={context.theme.text.muted}>{time()}</text> : null}
        <text fg={tone(context, props.check.state)}>{STATE[props.check.state].label}</text>
      </box>
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
    let lastSecond = Math.floor(Date.now() / 1000)
    // The renderer's animation clock only ticks while it is drawing, so a
    // plugin-level subscriber can freeze between renders. A plain timer keeps
    // the spinner and the clocks moving without holding renderer.idle() open.
    const tick = setInterval(() => {
      setFrame((value) => (value + 1) % SPINNER.length)
      const second = Math.floor(Date.now() / 1000)
      if (second !== lastSecond) {
        lastSecond = second
        setNow(Date.now())
      }
    }, 125)
    let cursor = 0
    let hold = 0
    const timer = setInterval(() => {
      if (cursor < STEPS.length) {
        STEPS[cursor]!()
        cursor += 1
        return
      }
      hold += 1
      if (hold > 2) {
        hold = 0
        cursor = 0
        setDemo(initial())
      }
    }, 2000)
    context.ui.slot({
      append: "sidebar.content",
      render: () => <Sidebar />,
    })
    return () => {
      clearInterval(tick)
      clearInterval(timer)
    }
  },
})
