import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { CiRpc, type CiJobState, type CiRunState, type CiState, type CiWatchState } from "./rpc.ts"

type CheckState = "pass" | "fail" | "run" | "queue" | "skip" | "cancel" | "neutral"

const STATE: Record<CheckState, { icon: string; tone: "success" | "error" | "warning" | "muted" | "faint" }> = {
  pass: { icon: "✓", tone: "success" },
  fail: { icon: "✗", tone: "error" },
  run: { icon: "●", tone: "warning" },
  queue: { icon: "○", tone: "warning" },
  skip: { icon: "»", tone: "faint" },
  cancel: { icon: "⊘", tone: "muted" },
  neutral: { icon: "·", tone: "muted" },
}

function iconFor(state: CheckState): string {
  return state === "run" ? (SPINNER[frame() % SPINNER.length] ?? STATE.run.icon) : STATE[state].icon
}

type Overall = "waiting" | "running" | "done" | "failed" | "canceled"

const OVERALL: Record<Overall, { dot: string; tone: CheckState }> = {
  waiting: { dot: "•", tone: "queue" },
  running: { dot: "•", tone: "run" },
  done: { dot: "•", tone: "pass" },
  failed: { dot: "•", tone: "fail" },
  canceled: { dot: "•", tone: "cancel" },
}

// GitHub's merged badge is purple.
const MERGED = "#c084fc"

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPIN_MS = 125

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

function parse(value: string | undefined): number | undefined {
  if (!value) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

function jobState(job: CiJobState): CheckState {
  if (job.conclusion === "success") return "pass"
  if (job.conclusion === "failure" || job.conclusion === "timed_out" || job.conclusion === "action_required")
    return "fail"
  if (job.conclusion === "cancelled") return "cancel"
  if (job.conclusion === "skipped") return "skip"
  if (job.conclusion === "neutral" || job.conclusion === "stale") return "neutral"
  if (job.status === "queued" || job.status === "pending" || job.status === "waiting") return "queue"
  if (job.status === "in_progress" || job.status === "requested") return "run"
  return "queue"
}

function runsOf(watch: CiWatchState): readonly CiRunState[] {
  if (watch.runs.length > 0) return watch.runs
  return watch.run ? [watch.run] : []
}

function primaryOf(watch: CiWatchState): CiRunState | undefined {
  const runs = runsOf(watch)
  return runs.find((run) => run.primary) ?? runs[0] ?? watch.run
}

function runState(run: CiRunState): CheckState {
  if (run.conclusion === "success") return "pass"
  if (run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "action_required")
    return "fail"
  if (run.conclusion === "cancelled") return "cancel"
  if (run.conclusion === "skipped") return "skip"
  if (run.conclusion === "neutral" || run.conclusion === "stale") return "neutral"
  if (run.status === "queued" || run.status === "pending" || run.status === "waiting") return "queue"
  if (run.status === "in_progress" || run.status === "requested") return "run"
  return "queue"
}

/**
 * GitHub reports a run as queued while some of its jobs already execute and the
 * rest wait for a runner, so a busy job always promotes the run to running.
 */
function runDisplayState(run: CiRunState, jobs: readonly CiJobState[]): CheckState {
  const state = runState(run)
  if (state === "queue" && jobs.some((job) => jobState(job) === "run")) return "run"
  return state
}

function overall(watch: CiWatchState): Overall {
  const runs = runsOf(watch)
  const primary = primaryOf(watch)
  const states = runs.map((run) => (run === primary ? runDisplayState(run, watch.jobs) : runState(run)))
  if (states.includes("fail")) return "failed"
  if (states.includes("run")) return "running"
  if (states.includes("queue")) return "waiting"
  if (!primary) return "waiting"
  const state = runDisplayState(primary, watch.jobs)
  if (state === "pass") return "done"
  if (state === "cancel" || state === "skip" || state === "neutral") return "canceled"
  if (primary.status === "completed") return "done"
  return "waiting"
}

function jobsHidden(watch: CiWatchState, at: number): boolean {
  if (watch.merged) return true
  const finished = parse(primaryOf(watch)?.finishedAt)
  return finished !== undefined && overall(watch) === "done" && at - finished >= 5_000
}

function runElapsed(run: CiRunState, at: number): string | undefined {
  const started = parse(run.startedAt)
  if (started === undefined) return undefined
  const finished = parse(run.finishedAt)
  return clock((finished ?? at) - started)
}

function jobElapsed(job: CiJobState, at: number): string | undefined {
  if (jobState(job) !== "run") return undefined
  const started = parse(job.startedAt)
  if (started === undefined) return undefined
  return clock(at - started)
}

function WatchLine(props: { watch: CiWatchState }) {
  const context = usePlugin()
  const state = createMemo(() => overall(props.watch))
  const color = () => (props.watch.merged ? MERGED : tone(context, OVERALL[state()].tone))
  return (
    <box flexDirection="row" gap={1} minWidth={0}>
      <text fg={color()} flexShrink={0}>
        {OVERALL[state()].dot}
      </text>
      <text fg={context.theme.text.base} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
        <b>{props.watch.target.value}</b>
      </text>
    </box>
  )
}

function CheckLine(props: { job: CiJobState }) {
  const context = usePlugin()
  const state = createMemo(() => jobState(props.job))
  const time = createMemo(() => jobElapsed(props.job, now()))
  return (
    <box flexDirection="row" gap={1} minWidth={0} paddingLeft={2}>
      <text fg={tone(context, state())} flexShrink={0}>
        {iconFor(state())}
      </text>
      <text fg={context.theme.text.muted} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
        {props.job.name}
      </text>
      {time() ? (
        <text fg={context.theme.text.muted} flexShrink={0}>
          {time()}
        </text>
      ) : null}
    </box>
  )
}

function WorkflowLine(props: { run: CiRunState; jobs: readonly CiJobState[] }) {
  const context = usePlugin()
  const state = createMemo(() => runDisplayState(props.run, props.jobs))
  const time = createMemo(() => runElapsed(props.run, now()))
  return (
    <box flexDirection="row" gap={1} minWidth={0}>
      <text fg={tone(context, state())} flexShrink={0}>
        {iconFor(state())}
      </text>
      <text fg={context.theme.text.muted} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
        <b>{props.run.name}</b>
      </text>
      {time() ? (
        <text fg={context.theme.text.muted} flexShrink={0}>
          {time()}
        </text>
      ) : null}
    </box>
  )
}

function Sidebar(props: { sessionID: string }) {
  const context = usePlugin()
  const [view, updateView] = context.storage.store("view", { initial: { open: true } })
  const [state, setState] = createSignal<CiState>()
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal(false)
  let reported = false

  const refresh = async (sessionID: string) => {
    try {
      const location = context.location ?? context.data.location.default()
      const next = (await context.client.rpc(CiRpc).state(
        { sessionID },
        { location, signal: AbortSignal.timeout(3_000) },
      )) as CiState
      if (sessionID === props.sessionID) {
        setState(next)
        setLoaded(true)
        setError(false)
      }
    } catch {
      if (sessionID === props.sessionID) setError(true)
    }
  }

  createEffect(() => {
    const sessionID = props.sessionID
    void refresh(sessionID)
  })

  onMount(() => {
    const stop = context.client.rpc(CiRpc).events.on("updated", (event) => {
      if (event.data.sessionID === props.sessionID) void refresh(props.sessionID)
    })
    // The TUI can mount before the server is ready, and a reconnect replaces the
    // client. Retry quickly until the first snapshot, then keep a slow safety net.
    const retry = setInterval(() => {
      if (!loaded() || error()) void refresh(props.sessionID)
    }, 2_000)
    const safety = setInterval(() => void refresh(props.sessionID), 30_000)
    onCleanup(() => {
      stop()
      clearInterval(retry)
      clearInterval(safety)
    })
  })

  const watches = createMemo(() => {
    const value = state()
    if (!value) return []
    return [...value.watches]
      .filter((watch) => watch.target.type === "branch")
      .sort((left, right) => {
        const leftDefault = left.target.value === value.defaultBranch
        const rightDefault = right.target.value === value.defaultBranch
        return leftDefault === rightDefault ? 0 : leftDefault ? -1 : 1
      })
  })
  const failed = createMemo(() => watches().filter((watch) => overall(watch) === "failed").length)
  return (
    <Show when={state()}>
      <box flexDirection="column">
        <Show
          when={watches().length > 0}
          fallback={
            <box flexDirection="row" gap={1}>
              <text fg={context.theme.text.base}>
                <b>GitHub</b>
              </text>
              <text fg={context.theme.text.muted}>no watches</text>
            </box>
          }
        >
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
              <b>GitHub</b>
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
                  {watch.merged ? null : (
                    <box flexDirection="column">
                      {primaryOf(watch) ? <WorkflowLine run={primaryOf(watch)!} jobs={watch.jobs} /> : null}
                      {jobsHidden(watch, now()) ? null : watch.jobs.map((job) => <CheckLine job={job} />)}
                      {runsOf(watch)
                        .filter((run) => !run.primary)
                        .map((run) => (
                          <WorkflowLine run={run} jobs={[]} />
                        ))}
                    </box>
                  )}
                </box>
              ))
            : null}
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "ci",
  setup(context) {
    let lastSecond = Math.floor(Date.now() / 1000)
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
      render: (props) => <Sidebar sessionID={props.sessionID} />,
    })
    return () => clearInterval(tick)
  },
})
