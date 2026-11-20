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
  merged?: boolean
  mergedAt?: number
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
      { name: "clippy", state: "pass", duration: "35s" },
      { name: "test", state: "pass", duration: "2m17s" },
      { name: "aarch64", state: "pass", duration: "1m04s" },
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

const STATE: Record<
  CheckState,
  { dot: string; label: string; tone: "success" | "error" | "warning" | "muted" | "faint" }
> = {
  pass: { dot: "●", label: "Passed", tone: "success" },
  fail: { dot: "●", label: "Failed", tone: "error" },
  run: { dot: "●", label: "Running", tone: "warning" },
  queue: { dot: "○", label: "Queued", tone: "warning" },
  skip: { dot: "○", label: "Skipped", tone: "faint" },
  cancel: { dot: "●", label: "Cancelled", tone: "muted" },
  neutral: { dot: "●", label: "Neutral", tone: "muted" },
}

type Overall = "waiting" | "running" | "done" | "failed"

// One overall dot per watched branch: empty orange while waiting, filled orange
// while running, green when everything finished, red as soon as something failed.
const OVERALL: Record<Overall, { dot: string; tone: CheckState }> = {
  waiting: { dot: "○", tone: "queue" },
  running: { dot: "●", tone: "run" },
  done: { dot: "●", tone: "pass" },
  failed: { dot: "●", tone: "fail" },
}

// GitHub's merged badge is purple.
const MERGED = "#c084fc"

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPIN_MS = 125

const [demo, setDemo] = createSignal<Watch[]>([])
const [frame, setFrame] = createSignal(0)
const [now, setNow] = createSignal(Date.now())

function tone(context: ReturnType<typeof usePlugin>, state: CheckState) {
  const feedback = context.theme.text.feedback
  if (state === "run") return feedback.warning.base
  if (state === "pass") return feedback.success.base
  if (state === "fail") return feedback.error.base
  if (state === "queue") return feedback.warning.base
  if (state === "skip") return context.theme.text.faint
  return context.theme.text.muted
}

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

function counts(watch: Watch) {
  const value = { total: watch.checks.length, passed: 0, failed: 0, running: 0, queued: 0, skipped: 0, other: 0 }
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

function overall(watch: Watch): Overall {
  const value = counts(watch)
  if (value.failed > 0) return "failed"
  if (value.running > 0) return "running"
  if (value.queued > 0) return "waiting"
  return "done"
}

function jobsHidden(watch: Watch, at: number): boolean {
  if (watch.merged) return true
  return watch.finishedAt !== undefined && overall(watch) === "done" && at - watch.finishedAt >= 5_000
}

// ---------------------------------------------------------------------------
// Demo script

const MAIN = BASE.find((watch) => watch.branch === "main")!
const FEATURE = BASE.find((watch) => watch.branch === "feature/login")!

function reset(template: Watch): Watch {
  return {
    branch: template.branch,
    run: template.run,
    checks: template.checks.map((check) => ({
      name: check.name,
      state: check.state === "skip" ? "skip" : "queue",
    })),
  }
}

const initial = (): Watch[] => [reset(FEATURE)]

type Change = [name: string, state: CheckState, duration?: string]

function setChecks(watches: Watch[], branch: string, changes: Change[]): Watch[] {
  const at = Date.now()
  return watches.map((watch) => {
    if (watch.branch !== branch || watch.merged) return watch
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

function merge(watches: Watch[], branch: string): Watch[] {
  const at = Date.now()
  return watches.map((watch) =>
    watch.branch === branch
      ? {
          ...watch,
          merged: true,
          mergedAt: at,
          checks: watch.checks.map((check) => ({ ...check, since: undefined })),
        }
      : watch,
  )
}

const SCRIPT: Array<{ at: number; run: () => void }> = [
  {
    at: 1.5,
    run: () =>
      setDemo((watches) =>
        setChecks(watches, "feature/login", [
          ["fmt", "run"],
          ["test", "run"],
        ]),
      ),
  },
  {
    at: 3,
    run: () =>
      setDemo((watches) =>
        setChecks(watches, "feature/login", [
          ["fmt", "pass", "9s"],
          ["test", "pass", "2m17s"],
        ]),
      ),
  },
  { at: 4.5, run: () => setDemo((watches) => [...merge(watches, "feature/login"), reset(MAIN)]) },
  {
    at: 6,
    run: () =>
      setDemo((watches) =>
        setChecks(watches, "main", [
          ["fmt", "run"],
          ["deny", "run"],
          ["model", "run"],
          ["provenance", "run"],
          ["test", "run"],
          ["aarch64", "run"],
        ]),
      ),
  },
  {
    at: 7.5,
    run: () =>
      setDemo((watches) =>
        setChecks(watches, "main", [
          ["fmt", "pass", "11s"],
          ["deny", "pass", "48s"],
          ["model", "pass", "10s"],
          ["provenance", "pass", "8s"],
          ["clippy", "run"],
        ]),
      ),
  },
  { at: 9, run: () => setDemo((watches) => setChecks(watches, "main", [["clippy", "fail", "21s"]])) },
  {
    at: 10.5,
    run: () =>
      setDemo((watches) =>
        setChecks(watches, "main", [
          ["test", "pass", "2m17s"],
          ["aarch64", "pass", "1m04s"],
          ["clippy", "run"],
        ]),
      ),
  },
  { at: 12, run: () => setDemo((watches) => setChecks(watches, "main", [["clippy", "pass", "35s"]])) },
]

const CYCLE_SECONDS = 24
const DEFAULT_BRANCH = "main"

// ---------------------------------------------------------------------------
// Components

function WatchLine(props: { watch: Watch }) {
  const context = usePlugin()
  const state = overall(props.watch)
  const time = createMemo(() => elapsed(props.watch, now()))
  const dot = props.watch.merged ? MERGED : tone(context, OVERALL[state].tone)
  return (
    <box flexDirection="row" gap={1} minWidth={0}>
      <text fg={dot} flexShrink={0}>
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
  // The default branch leads. Rows stay for as long as the subscription exists;
  // the UI only ages out the job list, never the branch itself.
  const visible = createMemo(() =>
    [...watches()].sort((left, right) =>
      left.branch === DEFAULT_BRANCH ? -1 : right.branch === DEFAULT_BRANCH ? 1 : 0,
    ),
  )
  const failed = createMemo(() => visible().filter((watch) => overall(watch) === "failed").length)

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
            ({visible().length} watched{failed() > 0 ? `, ${failed()} failed` : ""})
          </text>
        )}
      </box>
      {view.open
        ? visible().map((watch) => (
            <box flexDirection="column">
              <WatchLine watch={watch} />
              {jobsHidden(watch, now())
                ? null
                : watch.checks.map((check) => <CheckLine check={check} />)}
            </box>
          ))
        : null}
    </box>
  )
}

export default Plugin.define({
  id: "ci",
  setup(context) {
    setDemo(initial())
    let cycleStart = Date.now()
    let next = 0
    const timer = setInterval(() => {
      const elapsedSeconds = (Date.now() - cycleStart) / 1000
      if (elapsedSeconds >= CYCLE_SECONDS) {
        setDemo(initial())
        cycleStart = Date.now()
        next = 0
        return
      }
      while (next < SCRIPT.length && SCRIPT[next]!.at <= elapsedSeconds) {
        SCRIPT[next]!.run()
        next += 1
      }
    }, 250)

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
    }, SPIN_MS)

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
