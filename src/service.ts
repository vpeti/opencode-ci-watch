import { randomUUID } from "node:crypto"
import type { Config } from "./config.ts"
import { isFailure, isJobFailure, isTerminal, isSuccess } from "./events.ts"
import type { Enricher } from "./github/enrich.ts"
import type { Forwarder } from "./forwarder.ts"
import { errorMessage } from "./log.ts"
import { describeTarget, matchesJob, matchesPush, matchesRun, targetKey, targetMatchesDelivery } from "./match.ts"
import type { Notifier } from "./notify.ts"
import {
  conclusionEmoji,
  renderFailure,
  renderJobFailure,
  renderJobs,
  renderPush,
  renderRunLine,
  renderSuccess,
} from "./render.ts"
import type { SessionSummary } from "./sessions.ts"
import type { DeliveryMode, Include, JobCache, NotifyMode, RunCache, Subscription, SubscriptionStore } from "./store.ts"
import type { CiState } from "./state.ts"
import type { Delivery, JobInfo, Logger, MergeInfo, PushInfo, RepoRef, RunInfo, Target } from "./types.ts"

export class CiError extends Error {
  override name = "CiError"
}

export interface WatchInput {
  branch?: string
  sha?: string
  run?: number
  current?: boolean
  include?: Include[]
  notify?: NotifyMode
  delivery?: DeliveryMode
  ttlMinutes?: number
}

export interface TargetInput {
  branch?: string
  sha?: string
  run?: number
  current?: boolean
}

export interface StatusInput extends TargetInput {
  recent?: number
  include?: ("jobs" | "logs")[]
}

export interface WaitInput extends TargetInput {
  timeoutSeconds?: number
}

export interface LogInput {
  run: number
  job?: number
  maxChars?: number
}

export interface ToolResult {
  content: string
  metadata?: Record<string, unknown>
}

export interface ServiceDeps {
  readonly repo: RepoRef
  readonly config: Config
  readonly enricher: Enricher
  readonly store: SubscriptionStore
  readonly cache: RunCache
  readonly jobs: JobCache
  readonly defaultBranch: string
  readonly notifier: Notifier
  readonly forwarder: Forwarder
  readonly log: Logger
  readonly currentBranch: () => Promise<string | undefined>
  readonly now?: () => number
  readonly id?: () => string
  /** Delay before an all-green wake, so a sibling workflow has time to register. */
  readonly greenSettleMs?: number
  /** Delay before resolving a waiter once every run is terminal. */
  readonly settleMs?: number
  /** Called after a subscription, run, job or merge changes so the TUI can refetch. */
  readonly onStateChanged?: (sessionID: string) => void
  /** Cross-process claim so two plugin instances do not wake the same session twice. */
  readonly ledger?: { claim(key: string): Promise<boolean> }
}

interface Waiter {
  readonly id: string
  readonly sessionID: string
  readonly target: Target
  sha: string | undefined
  readonly runs: Map<number, RunInfo>
  readonly startedAt: number
  settle: NodeJS.Timeout | undefined
  finished: boolean
  finish: (result: ToolResult & { outcome: string }) => void
}

const DAY = 24 * 60 * 60 * 1000
const REPLAY_WINDOW_MS = DAY
const MAX_STATUS_LINES = 6
const SETTLE_MS = 15_000
const WAITER_KEY = "__opencodeCiWatchWaiters"

/** Waiters parked by a stopped plugin instance, so a reload can adopt them. */
function detachedWaiters(): Set<Waiter> {
  const holder = globalThis as typeof globalThis & { [WAITER_KEY]?: Set<Waiter> }
  return (holder[WAITER_KEY] ??= new Set<Waiter>())
}

const INCLUDE_ORDER: readonly Include[] = ["runs", "pushes"]
const NOTIFY_RANK: Record<NotifyMode, number> = { none: 0, failures: 1, all: 2 }

function mergeInclude(left: readonly Include[], right: readonly Include[]): Include[] {
  return INCLUDE_ORDER.filter((entry) => left.includes(entry) || right.includes(entry))
}

function mergeSubscriptions(base: Subscription, extra: Subscription): Subscription {
  return {
    ...base,
    include: mergeInclude(base.include, extra.include),
    notify: NOTIFY_RANK[extra.notify] > NOTIFY_RANK[base.notify] ? extra.notify : base.notify,
    delivery: base.delivery === "steer" || extra.delivery === "steer" ? "steer" : "queue",
    createdAt: Math.min(base.createdAt, extra.createdAt),
    expiresAt: Math.max(base.expiresAt, extra.expiresAt),
    mergedAt: extra.mergedAt ?? base.mergedAt,
  }
}

function runTime(run: RunInfo): number | undefined {
  const value = run.updatedAt ?? run.createdAt ?? run.startedAt
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export class CiService {
  private readonly deps: ServiceDeps
  private readonly waiters = new Set<Waiter>()
  private readonly suppressed = new Map<string, Set<string>>()
  /** Deliveries already handled here, so a redelivered webhook cannot wake twice. */
  private readonly delivered = new Map<string, number>()
  private readonly greenTimers = new Map<string, NodeJS.Timeout>()
  private idleTimer: NodeJS.Timeout | undefined

  constructor(deps: ServiceDeps) {
    this.deps = deps
  }

  private get now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private get slug(): string {
    return this.deps.repo.slug
  }

  async start(): Promise<void> {
    await this.deps.store.load()
    await this.deps.store.prune(this.now)
    await this.compactSubscriptions()
    if (this.deps.store.size > 0) await this.ensureForwarder()
    const sessions = new Set(this.deps.store.list().map((entry) => entry.sessionID))
    for (const sessionID of sessions) await this.refreshStatus(sessionID)
    for (const target of new Map(this.deps.store.list().map((entry) => [targetKey(entry.target), entry.target])).values()) {
      await this.reconcile(target, true).catch((error) => {
        this.deps.log.warn(`cannot reconcile ${targetKey(target)}`, { error: errorMessage(error) })
      })
    }
    await this.adoptWaiters()
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    // A reload creates a new service in the same process. Park pending waits so
    // that instance can adopt them instead of resolving every caller as cancelled.
    for (const waiter of this.waiters) {
      if (waiter.settle) clearTimeout(waiter.settle)
      waiter.settle = undefined
      if (!waiter.finished) detachedWaiters().add(waiter)
    }
    this.waiters.clear()
    for (const timer of this.greenTimers.values()) clearTimeout(timer)
    this.greenTimers.clear()
    await this.deps.forwarder.stop()
  }

  /** Collapse duplicate subscriptions left by reloads or overlapping watches. */
  private async compactSubscriptions(): Promise<void> {
    const sessions = new Set(this.deps.store.list().map((entry) => entry.sessionID))
    for (const sessionID of sessions) {
      const byTarget = new Map<string, Subscription>()
      for (const subscription of this.deps.store.bySession(sessionID)) {
        const key = targetKey(subscription.target)
        const base = byTarget.get(key)
        if (!base) {
          byTarget.set(key, subscription)
          continue
        }
        const merged = mergeSubscriptions(base, subscription)
        byTarget.set(key, merged)
        await this.deps.store.remove(subscription.id)
        await this.deps.store.save(merged)
      }
    }
  }

  /** Reattach waits parked by a previous plugin instance in this process. */
  private async adoptWaiters(): Promise<void> {
    const waiters = [...detachedWaiters()]
    if (waiters.length === 0) return
    const targets = new Map<string, Target>()
    for (const waiter of waiters) targets.set(targetKey(waiter.target), waiter.target)
    for (const target of targets.values()) {
      await this.reconcile(target).catch((error) => {
        this.deps.log.warn(`cannot reconcile a parked wait for ${targetKey(target)}`, { error: errorMessage(error) })
      })
    }
    for (const waiter of waiters) {
      detachedWaiters().delete(waiter)
      if (waiter.finished) continue
      this.waiters.add(waiter)
      this.suppress(waiter.sessionID, waiter.target)
      const finish = waiter.finish
      waiter.finish = (result) => {
        this.unsuppress(waiter.sessionID, waiter.target)
        finish(result)
      }
      for (const run of this.cachedRuns(waiter.target, 20)) this.considerWaiter(waiter, run)
    }
  }

  health(): string | undefined {
    const state = this.deps.forwarder.state
    if (state === "running" || state === "starting") return undefined
    if (state === "stopped" && this.deps.store.size === 0) return undefined
    const detail = this.deps.forwarder.lastError
    const last = this.deps.forwarder.history?.at(-1)
    const when = last ? new Date(last.at).toISOString().slice(11, 19) : undefined
    const trace = last && when ? ` · last ${last.state} at ${when}` : ""
    return `⚠️ ci event stream: ${state}${detail ? ` (${detail})` : ""}${trace}`
  }

  async ensureForwarder(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    if (this.deps.store.size === 0) return
    if (this.deps.forwarder.state === "forbidden") return
    if (this.deps.forwarder.state === "running" || this.deps.forwarder.state === "starting") return
    await this.deps.forwarder.start()
  }

  private scheduleForwarderStop(): void {
    if (this.deps.store.size > 0 || this.idleTimer) return
    this.idleTimer = setTimeout(
      () => {
        this.idleTimer = undefined
        if (this.deps.store.size === 0) void this.deps.forwarder.stop()
      },
      this.deps.config.forwarder.idleTimeoutMinutes * 60 * 1000,
    )
    this.idleTimer.unref()
  }

  // ---------------------------------------------------------------------------
  // targets

  private async currentBranch(): Promise<string> {
    const branch = await this.deps.currentBranch()
    if (!branch) throw new CiError("cannot determine the current git branch; pass `branch` explicitly")
    return branch
  }

  async resolveTarget(input: TargetInput): Promise<Target> {
    const given = [input.branch, input.sha, input.run !== undefined ? String(input.run) : undefined, input.current ? "current" : undefined]
      .filter((value) => value !== undefined)
    if (given.length > 1) throw new CiError("pass only one of `branch`, `sha`, `run` or `current`")

    if (input.run !== undefined) {
      if (!Number.isInteger(input.run) || input.run <= 0) throw new CiError("`run` must be a workflow run id")
      return { type: "run", value: String(input.run) }
    }
    if (input.sha) {
      const sha = input.sha.trim().toLowerCase()
      if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new CiError("`sha` must be a 7-40 character commit sha")
      return { type: "sha", value: sha }
    }
    if (input.branch) {
      const branch = input.branch.trim().replace(/^refs\/heads\//, "")
      if (!branch) throw new CiError("`branch` must not be empty")
      return { type: "branch", value: branch }
    }
    return { type: "branch", value: await this.currentBranch() }
  }

  private cachedRuns(target: Target, limit = 20): RunInfo[] {
    if (target.type === "branch") return this.deps.cache.forBranch(this.slug, target.value, limit)
    if (target.type === "sha") return this.deps.cache.forSha(this.slug, target.value, limit)
    const run = this.deps.cache.get(this.slug, Number(target.value))
    return run ? [run] : []
  }

  /** All runs for the newest commit of a target, in no particular order. */
  private newestRuns(target: Target): RunInfo[] {
    if (target.type === "run") {
      const run = this.deps.cache.get(this.slug, Number(target.value))
      return run ? [run] : []
    }
    const runs = this.cachedRuns(target)
    if (runs.length === 0) return []
    const newest = [...runs].sort(
      (left, right) =>
        (Date.parse(right.createdAt ?? "") || 0) - (Date.parse(left.createdAt ?? "") || 0) || right.id - left.id,
    )[0]!
    return runs.filter((run) => run.sha === newest.sha)
  }

  /** Runs the dashboard shows: manual and scheduled workflows are not push/PR reactions. */
  private dashboardRuns(target: Target): RunInfo[] {
    const runs = this.newestRuns(target)
    if (target.type === "run") return runs
    return runs.filter((run) => run.event !== "workflow_dispatch" && run.event !== "schedule")
  }

  /**
   * The workflow the dashboard treats as primary. The CI matrix is usually the run
   * with the most jobs; failure wins a tie, then the newest run.
   */
  private primaryRun(runs: readonly RunInfo[]): RunInfo | undefined {
    const ranked = [...runs].sort((left, right) => {
      const leftJobs = this.deps.jobs.forRun(left.id).length
      const rightJobs = this.deps.jobs.forRun(right.id).length
      if (leftJobs !== rightJobs) return rightJobs - leftJobs
      if (isFailure(left) !== isFailure(right)) return isFailure(left) ? -1 : 1
      return right.id - left.id
    })
    // Pin the conventional CI workflow so hydration cannot flip the primary row.
    return ranked.find((run) => run.name.trim().toLowerCase() === "ci") ?? ranked[0]
  }

  /**
   * A run reads as running when GitHub says so or when one of its jobs is
   * executing. GitHub reports a run as queued again when the remaining jobs wait
   * for a runner, which would otherwise hide a busy workflow.
   */
  private isRunning(run: RunInfo): boolean {
    if (isTerminal(run)) return false
    if (run.status === "in_progress" || run.status === "requested") return true
    return this.deps.jobs.forRun(run.id).some((job) => job.status === "in_progress")
  }

  /** Aggregates every run for the newest commit, with explicit labels for skipped and cancelled. */
  private summaryFor(target: Target): string {
    if (target.type === "run") {
      const run = this.deps.cache.get(this.slug, Number(target.value))
      return run ? `${conclusionEmoji(run.conclusion)} ${run.name} ${run.conclusion ?? run.status}` : "no run yet"
    }
    const runs = this.dashboardRuns(target)
    if (runs.length === 0) return "no runs yet"
    const running = runs.filter((run) => this.isRunning(run)).length
    const queued = runs.filter((run) => !isTerminal(run) && !this.isRunning(run)).length
    const failed = runs.filter(isFailure).length
    const passed = runs.filter(isSuccess).length
    const skipped = runs.filter((run) => run.conclusion === "skipped").length
    const cancelled = runs.filter((run) => run.conclusion === "cancelled").length
    const other = runs.filter(
      (run) =>
        isTerminal(run) &&
        !isFailure(run) &&
        !isSuccess(run) &&
        run.conclusion !== "skipped" &&
        run.conclusion !== "cancelled",
    ).length
    const parts: string[] = []
    if (running > 0) parts.push(`⏳ ${running} running`)
    if (queued > 0) parts.push(`○ ${queued} queued`)
    if (failed > 0) parts.push(`❌ ${failed} failed`)
    if (passed > 0) parts.push(`✅ ${passed} passed`)
    if (skipped > 0) parts.push(`⏭ ${skipped} skipped`)
    if (cancelled > 0) parts.push(`⊘ ${cancelled} cancelled`)
    if (other > 0) parts.push(`⚪ ${other} other`)
    const sha = runs[0]?.sha
    return `${parts.join(" · ") || "no result"}${sha ? ` · ${sha.slice(0, 7)}` : ""}`
  }

  /** Green only when the newest commit is settled and its primary workflow succeeded. */
  private settledFor(target: Target, sha: string): boolean {
    if (target.type === "branch") {
      const newest = this.newestRuns(target)[0]
      if (newest && newest.sha !== sha) return false
    }
    const runs = this.newestRuns(target).filter((run) => run.sha === sha)
    if (runs.length === 0 || !runs.every(isTerminal) || runs.some(isFailure)) return false
    const primary = this.primaryRun(runs)
    return primary !== undefined && isSuccess(primary)
  }

  private scheduleGreen(subscription: Subscription, sha: string): void {
    const key = `${subscription.id}:${sha}`
    if (this.greenTimers.has(key)) return
    const timer = setTimeout(async () => {
      this.greenTimers.delete(key)
      if (!this.settledFor(subscription.target, sha)) return
      if (!this.summaryFor(subscription.target).includes("passed")) return
      if (await this.seen(`green:${subscription.id}:${sha}`)) return
      void this.deps.notifier.wake(
        subscription.sessionID,
        this.greenNotice(subscription.target),
        subscription.delivery,
      )
    }, this.deps.greenSettleMs ?? 5_000)
    timer.unref()
    this.greenTimers.set(key, timer)
  }

  private greenNotice(target: Target): string {
    return `✅ ${describeTarget(target)} · ${this.summaryFor(target).replace(/^✅ /, "")}`
  }

  private runState(run: RunInfo, primary: boolean) {
    return {
      id: run.id,
      name: run.name,
      branch: run.branch,
      sha: run.sha,
      status: run.status,
      conclusion: run.conclusion,
      url: run.url,
      ...(typeof (run.startedAt ?? run.createdAt) === "string" ? { startedAt: (run.startedAt ?? run.createdAt)! } : {}),
      ...(isTerminal(run) && typeof run.updatedAt === "string" ? { finishedAt: run.updatedAt } : {}),
      jobCount: this.deps.jobs.forRun(run.id).length,
      primary,
    }
  }

  // ---------------------------------------------------------------------------
  // subscriptions

  async watch(sessionID: string, input: WatchInput): Promise<ToolResult> {
    const target = await this.resolveTarget(input)
    const requested = (input.include ?? []).filter((entry): entry is Include => entry === "runs" || entry === "pushes")
    const requestedInclude = requested.length > 0 ? [...new Set(requested)] : (["runs"] as Include[])
    const matches = this.deps.store
      .bySession(sessionID)
      .filter((entry) => targetKey(entry.target) === targetKey(target))
    const existing = matches[0]
    const include = existing ? mergeInclude(existing.include, requestedInclude) : requestedInclude
    const notify: NotifyMode =
      input.notify === "all" || input.notify === "none" || input.notify === "failures"
        ? input.notify
        : this.deps.config.notify.success
          ? "all"
          : "failures"
    const delivery: DeliveryMode = input.delivery === "steer" ? "steer" : this.deps.config.notify.delivery
    const ttlMinutes = Math.min(7 * 24 * 60, Math.max(5, input.ttlMinutes ?? 24 * 60))
    const expiresAt = this.now + ttlMinutes * 60 * 1000

    for (const duplicate of matches.slice(1)) await this.deps.store.remove(duplicate.id)
    const subscription: Subscription = existing
      ? { ...existing, include, expiresAt, notify, delivery, mergedAt: undefined }
      : {
          id: this.deps.id?.() ?? randomUUID().slice(0, 8),
          repo: this.slug,
          sessionID,
          target,
          include,
          notify,
          delivery,
          createdAt: this.now,
          expiresAt,
        }
    await this.deps.store.save(subscription)
    this.changed(sessionID)
    await this.ensureForwarder()
    await this.refreshStatus(sessionID)
    void this.reconcile(target).catch((error) => this.deps.log.warn(`cannot reconcile ${targetKey(target)}`, { error: errorMessage(error) }))

    const status = this.summaryFor(target)
    return {
      content: `👀 watching ${describeTarget(target)} (${include.join("+")}, notify ${notify}) · ${status} · id ${subscription.id}`,
      metadata: { id: subscription.id, target, include, notify: subscription.notify, sessionID },
    }
  }

  async unwatch(sessionID: string, input: { id?: string; branch?: string; sha?: string; run?: number; all?: boolean }): Promise<ToolResult> {
    if (input.all) {
      const removed = await this.deps.store.removeSession(sessionID)
      this.changed(sessionID)
      await this.refreshStatus(sessionID)
      this.scheduleForwarderStop()
      return { content: removed === 0 ? "nothing to unwatch" : `👋 stopped watching ${removed} target(s)`, metadata: { removed } }
    }
    if (input.id) {
      const sub = this.deps.store.list().find((entry) => entry.id === input.id && entry.sessionID === sessionID)
      if (!sub) throw new CiError(`no subscription "${input.id}" for this session`)
      await this.deps.store.remove(sub.id)
      this.changed(sessionID)
      await this.refreshStatus(sessionID)
      this.scheduleForwarderStop()
      return { content: `👋 stopped watching ${describeTarget(sub.target)}`, metadata: { removed: 1 } }
    }

    const target = await this.resolveTarget(input)
    const matches = this.deps.store
      .bySession(sessionID)
      .filter((entry) => targetKey(entry.target) === targetKey(target))
    for (const entry of matches) await this.deps.store.remove(entry.id)
    this.changed(sessionID)
    await this.refreshStatus(sessionID)
    this.scheduleForwarderStop()
    return {
      content: matches.length === 0 ? `was not watching ${describeTarget(target)}` : `👋 stopped watching ${describeTarget(target)}`,
      metadata: { removed: matches.length },
    }
  }

  private async reconcile(target: Target, replay = false): Promise<void> {
    if (target.type === "branch") {
      const runs = await this.deps.enricher.recentRuns(target.value, 10)
      for (const run of runs) this.deps.cache.set(this.slug, run, this.now)
      const latest = runs[0]
      if (latest) {
        const forSha = runs.filter((run) => run.sha === latest.sha).slice(0, 4)
        for (const run of forSha) {
          if (this.deps.jobs.forRun(run.id).length === 0) await this.fetchJobs(run)
        }
      }
      const sessions = new Set(
        this.deps.store
          .list()
          .filter((entry) => entry.target.type === "branch" && entry.target.value === target.value)
          .map((entry) => entry.sessionID),
      )
      for (const sessionID of sessions) {
        await this.refreshStatus(sessionID)
        this.changed(sessionID)
      }
      if (replay) await this.replayRuns(runs, target)
      return
    }
    if (target.type === "sha") {
      const runs = await this.deps.enricher.runsForSha(target.value, 10)
      for (const run of runs) this.deps.cache.set(this.slug, run, this.now)
      const latest = runs[0]
      if (latest) {
        const forSha = runs.filter((run) => run.sha === latest.sha).slice(0, 4)
        for (const run of forSha) {
          if (this.deps.jobs.forRun(run.id).length === 0) await this.fetchJobs(run)
        }
      }
      const sessions = new Set(
        this.deps.store
          .list()
          .filter((entry) => entry.target.type === "sha" && entry.target.value === target.value)
          .map((entry) => entry.sessionID),
      )
      for (const sessionID of sessions) {
        await this.refreshStatus(sessionID)
        this.changed(sessionID)
      }
      if (replay) await this.replayRuns(runs, target)
      return
    }
    const run = await this.deps.enricher.run(Number(target.value))
    if (run) {
      this.deps.cache.set(this.slug, run, this.now)
      if (this.deps.jobs.forRun(run.id).length === 0) await this.fetchJobs(run)
      if (replay && isTerminal(run)) await this.onRun(run)
      for (const entry of this.deps.store.list()) {
        if (entry.target.type === "run" && entry.target.value === String(run.id)) this.changed(entry.sessionID)
      }
    }
  }

  /**
   * Deliver terminal runs that finished while the plugin was unloaded. The
   * delivery ledger keeps runs already notified from being replayed, so this can
   * safely look at the recent window on every reload.
   */
  private async replayRuns(runs: readonly RunInfo[], target: Target): Promise<void> {
    const subscriptions = this.deps.store
      .list()
      .filter((entry) => targetKey(entry.target) === targetKey(target))
    if (subscriptions.length === 0) return
    const since = Math.min(...subscriptions.map((entry) => entry.createdAt))
    // Only the recent past is replayed. A session that returns after days or
    // months must not get a backlog of old run notifications.
    const cutoff = this.now - REPLAY_WINDOW_MS
    const candidates = runs
      .filter((run) => isTerminal(run))
      .filter((run) => {
        const at = runTime(run)
        return at !== undefined && at >= since && at >= cutoff
      })
      .sort((left, right) => (runTime(left) ?? 0) - (runTime(right) ?? 0))
    for (const run of candidates) await this.onRun(run)
  }

  private async fetchJobs(run: RunInfo): Promise<JobInfo[]> {
    try {
      const jobs = await this.deps.enricher.jobs(run.id)
      this.deps.jobs.replace(run.id, jobs, this.now)
      return jobs
    } catch (error) {
      this.deps.log.warn("cannot read job results", { run: run.id, error: errorMessage(error) })
      return []
    }
  }

  private changed(sessionID: string): void {
    try {
      this.deps.onStateChanged?.(sessionID)
    } catch (error) {
      this.deps.log.warn("state observer failed", { sessionID, error: errorMessage(error) })
    }
  }

  /**
   * Snapshot for the TUI dashboard. `descendants` are child sessions of the
   * viewed one, so an orchestrator sees the targets its subagents watch.
   * Optional fields are omitted so the RPC schema validates.
   */
  async state(sessionID: string, descendants: readonly SessionSummary[] = []): Promise<CiState> {
    interface Scoped {
      readonly subscription: Subscription
      readonly sessionID?: string
      readonly sessionTitle?: string
    }
    const scope: Scoped[] = [
      ...this.deps.store.bySession(sessionID).map((subscription) => ({ subscription })),
      ...descendants.flatMap((session) =>
        this.deps.store
          .bySession(session.id)
          .map((subscription) => ({ subscription, sessionID: session.id, sessionTitle: session.title })),
      ),
    ]
    const watches = scope.map(({ subscription, sessionID: owner, sessionTitle }) => {
      const runs = this.dashboardRuns(subscription.target)
      const primary = this.primaryRun(runs)
      const runStates = runs
        .map((run) => this.runState(run, run.id === primary?.id))
        .sort((left, right) =>
          left.primary === right.primary ? left.name.localeCompare(right.name) : left.primary ? -1 : 1,
        )
      const primaryState = runStates.find((run) => run.primary)
      const jobs = primary
        ? this.deps.jobs.forRun(primary.id).map((job) => ({
            id: job.id,
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
            ...(typeof job.startedAt === "string" ? { startedAt: job.startedAt } : {}),
            ...(typeof job.completedAt === "string" ? { completedAt: job.completedAt } : {}),
          }))
        : []
      return {
        id: subscription.id,
        target: subscription.target,
        include: subscription.include,
        notify: subscription.notify,
        merged: subscription.mergedAt !== undefined,
        ...(subscription.mergedAt !== undefined ? { mergedAt: subscription.mergedAt } : {}),
        ...(owner ? { sessionID: owner } : {}),
        ...(sessionTitle ? { sessionTitle } : {}),
        ...(primaryState ? { run: primaryState } : {}),
        runs: runStates,
        jobs,
      }
    })
    return { defaultBranch: this.deps.defaultBranch, watches }
  }

  async refreshStatus(sessionID: string): Promise<void> {
    const subs = this.deps.store.bySession(sessionID)
    if (subs.length === 0) {
      await this.deps.notifier.setStatus(sessionID, undefined)
      return
    }
    const lines: string[] = []
    for (const sub of subs.slice(0, MAX_STATUS_LINES)) {
      const modes = [sub.include.includes("runs") ? "runs" : undefined, sub.include.includes("pushes") ? "pushes" : undefined]
        .filter(Boolean)
        .join("+")
      const detail =
        sub.include.includes("pushes") && !sub.include.includes("runs") ? "watching pushes" : this.summaryFor(sub.target)
      lines.push(`👀 ${describeTarget(sub.target)} · ${modes} · ${detail}`)
    }
    if (subs.length > MAX_STATUS_LINES) lines.push(`… ${subs.length - MAX_STATUS_LINES} more`)
    const health = this.health()
    if (health) lines.push(health)
    await this.deps.notifier.setStatus(sessionID, lines.join("\n"))
  }

  // ---------------------------------------------------------------------------
  // reads

  async status(input: StatusInput): Promise<ToolResult> {
    const target = await this.resolveTarget(input)
    const runs = await this.loadRuns(target, input.recent ?? 3)
    const withJobs = input.include?.includes("jobs") === true
    const withLogs = input.include?.includes("logs") === true
    if (runs.length === 0) {
      // A push notification arrives before GitHub creates the run, so "yet" matters.
      const hint = target.type === "sha" ? " · GitHub may still be creating one" : ""
      return { content: `no workflow runs yet for ${describeTarget(target)}${hint}`, metadata: { target, runs: [] } }
    }

    const lines: string[] = []
    const metadata: Array<Record<string, unknown>> = []
    for (const run of runs.slice(0, input.recent ?? 3)) {
      lines.push(renderRunLine(run, this.now))
      let jobs: JobInfo[] = []
      if (withJobs || (withLogs && isFailure(run))) {
        try {
          jobs = await this.fetchJobs(run)
          this.deps.cache.set(this.slug, run, this.now)
        } catch (error) {
          lines.push(`  ⚠️ cannot read jobs: ${errorMessage(error)}`)
        }
      }
      if (withJobs && jobs.length > 0) lines.push(...renderJobs(jobs).map((line) => `  ${line}`))
      if (withLogs && isFailure(run)) {
        const failed = jobs.find((job) => job.conclusion === "failure" || job.conclusion === "timed_out")
        try {
          const excerpt = await this.deps.enricher.failedLog(run.id, failed?.id, this.deps.config.maxLogChars)
          if (excerpt.text) lines.push(...excerpt.text.split("\n").map((line) => `  ${line}`))
        } catch (error) {
          lines.push(`  ⚠️ cannot read the failed log: ${errorMessage(error)}`)
        }
      }
      metadata.push({ id: run.id, name: run.name, branch: run.branch, sha: run.sha, status: run.status, conclusion: run.conclusion })
    }
    const health = this.health()
    if (health) lines.push(health)
    return { content: lines.join("\n"), metadata: { target, runs: metadata } }
  }

  private async loadRuns(target: Target, recent: number): Promise<RunInfo[]> {
    if (target.type === "branch") {
      try {
        const runs = await this.deps.enricher.recentRuns(target.value, Math.min(10, Math.max(1, recent)))
        for (const run of runs) this.deps.cache.set(this.slug, run, this.now)
        return runs
      } catch (error) {
        this.deps.log.warn("cannot list workflow runs", { error: errorMessage(error) })
        return this.deps.cache.forBranch(this.slug, target.value, recent)
      }
    }
    if (target.type === "sha") {
      try {
        const runs = await this.deps.enricher.runsForSha(target.value, Math.min(10, Math.max(1, recent)))
        for (const run of runs) this.deps.cache.set(this.slug, run, this.now)
        return runs
      } catch (error) {
        this.deps.log.warn("cannot list workflow runs for sha", { error: errorMessage(error) })
        return this.deps.cache.forSha(this.slug, target.value, recent)
      }
    }
    const cached = this.deps.cache.get(this.slug, Number(target.value))
    if (cached) return [cached]
    const run = await this.deps.enricher.run(Number(target.value), undefined)
    if (!run) return []
    this.deps.cache.set(this.slug, run, this.now)
    return [run]
  }

  async logs(input: LogInput): Promise<ToolResult> {
    if (!Number.isInteger(input.run) || input.run <= 0) throw new CiError("`run` must be a workflow run id")
    const maxChars = Math.min(4000, Math.max(200, input.maxChars ?? this.deps.config.maxLogChars))
    let jobId = input.job
    if (jobId === undefined) {
      try {
        const jobs = await this.deps.enricher.jobs(input.run)
        jobId = jobs.find((job) => job.conclusion === "failure" || job.conclusion === "timed_out")?.id
      } catch {
        // Fall back to the whole run.
      }
    }
    const excerpt = await this.deps.enricher.failedLog(input.run, jobId, maxChars)
    if (!excerpt.text) {
      return { content: `run ${input.run} has no failed step logs`, metadata: { run: input.run, job: jobId } }
    }
    return {
      content: excerpt.text,
      metadata: { run: input.run, job: jobId, step: excerpt.step, chars: excerpt.text.length },
    }
  }

  // ---------------------------------------------------------------------------
  // waiting

  async wait(sessionID: string, input: WaitInput, signal?: AbortSignal): Promise<ToolResult> {
    const target = await this.resolveTarget(input)
    const timeoutSeconds = Math.min(900, Math.max(5, input.timeoutSeconds ?? this.deps.config.waitTimeoutSeconds))
    await this.ensureForwarder()

    const baseline = await this.baseline(target)
    if (baseline.done) return this.waitResult(baseline.runs, "completed")

    return await new Promise<ToolResult>((resolve) => {
      const waiter: Waiter = {
        id: randomUUID().slice(0, 8),
        sessionID,
        target,
        sha: baseline.sha,
        runs: new Map(baseline.runs.map((run) => [run.id, run])),
        startedAt: this.now,
        settle: undefined,
        finished: false,
        finish: (result) => {
          if (waiter.finished) return
          waiter.finished = true
          if (waiter.settle) clearTimeout(waiter.settle)
          clearTimeout(timer)
          this.waiters.delete(waiter)
          detachedWaiters().delete(waiter)
          this.unsuppress(sessionID, target)
          resolve({ content: result.content, metadata: result.metadata })
        },
      }
      this.waiters.add(waiter)
      this.suppress(sessionID, target)

      const timer = setTimeout(() => {
        const runs = [...waiter.runs.values()]
        const content =
          runs.length === 0
            ? `⏳ no CI result for ${describeTarget(target)} within ${timeoutSeconds}s`
            : `${runs.map((run) => renderRunLine(run, this.now)).join("\n")}\n⏳ still running after ${timeoutSeconds}s`
        waiter.finish({ outcome: "timeout", content, metadata: { target, timeoutSeconds, runs: runs.map((run) => run.id) } })
      }, timeoutSeconds * 1000)
      timer.unref()

      if (signal) {
        if (signal.aborted) waiter.finish({ outcome: "cancelled", content: "ci wait cancelled", metadata: {} })
        else signal.addEventListener("abort", () => waiter.finish({ outcome: "cancelled", content: "ci wait cancelled", metadata: {} }), { once: true })
      }
    })
  }

  private async baseline(target: Target): Promise<{ sha?: string; runs: RunInfo[]; done: boolean }> {
    if (target.type === "run") {
      const run = await this.deps.enricher.run(Number(target.value))
      if (!run) throw new CiError(`workflow run ${target.value} not found`)
      this.deps.cache.set(this.slug, run, this.now)
      return { sha: run.sha, runs: [run], done: isTerminal(run) }
    }
    if (target.type === "sha") {
      const runs = await this.deps.enricher.runsForSha(target.value, 10)
      for (const run of runs) this.deps.cache.set(this.slug, run, this.now)
      return { sha: target.value, runs, done: runs.length > 0 && runs.every(isTerminal) }
    }
    const recent = await this.deps.enricher.recentRuns(target.value, 5)
    for (const run of recent) this.deps.cache.set(this.slug, run, this.now)
    const sha = recent[0]?.sha
    if (!sha) return { runs: [], done: false }
    const runs = recent.filter((run) => run.sha === sha)
    return { sha, runs, done: runs.length > 0 && runs.every(isTerminal) }
  }

  private waitResult(runs: RunInfo[], outcome: string): ToolResult {
    const failed = runs.filter(isFailure)
    const content = runs.map((run) => renderRunLine(run, this.now)).join("\n")
    return {
      content: failed.length > 0 ? `${content}\n↳ gh run view ${failed[0]!.id} --log-failed` : content,
      metadata: { outcome, runs: runs.map((run) => ({ id: run.id, conclusion: run.conclusion, sha: run.sha })) },
    }
  }

  private suppress(sessionID: string, target: Target): void {
    const key = targetKey(target)
    const set = this.suppressed.get(sessionID) ?? new Set<string>()
    set.add(key)
    this.suppressed.set(sessionID, set)
  }

  private unsuppress(sessionID: string, target: Target): void {
    const set = this.suppressed.get(sessionID)
    if (!set) return
    set.delete(targetKey(target))
    if (set.size === 0) this.suppressed.delete(sessionID)
  }

  private isSuppressed(sessionID: string, target: Target): boolean {
    return this.suppressed.get(sessionID)?.has(targetKey(target)) === true
  }

  // ---------------------------------------------------------------------------
  // delivery

  async onDelivery(delivery: Delivery): Promise<void> {
    if (delivery.kind === "workflow_run") await this.onRun(delivery.run)
    else if (delivery.kind === "push") await this.onPush(delivery.push)
    else if (delivery.kind === "job") await this.onJob(delivery.job)
    else await this.onMerge(delivery.merge)
  }

  private async onPush(push: PushInfo): Promise<void> {
    if (process.env.CI_WATCH_DEBUG)
      this.deps.log.info("push delivery", { branch: push.branch, subs: this.deps.store.list().length })
    // GitHub can redeliver a hook, and the forwarder replays on reconnect.
    if (await this.seen(`push:${push.branch}:${push.after}`)) return
    const sessions = new Set<string>()
    for (const subscription of this.deps.store.list()) {
      const targets = subscription.target.type === "branch" && subscription.target.value === push.branch
      if (!targets && !matchesPush(subscription, push)) continue
      if (targets && subscription.mergedAt !== undefined) {
        await this.deps.store.save({ ...subscription, mergedAt: undefined })
      }
      sessions.add(subscription.sessionID)
      if (!matchesPush(subscription, push)) continue
      await this.refreshStatus(subscription.sessionID)
      if (this.isSuppressed(subscription.sessionID, subscription.target)) continue
      await this.deps.notifier.wake(subscription.sessionID, renderPush(push), subscription.delivery)
    }
    for (const sessionID of sessions) this.changed(sessionID)
    for (const waiter of [...this.waiters]) {
      if (waiter.target.type !== "branch" || waiter.target.value !== push.branch) continue
      if (!waiter.sha) waiter.sha = push.after
    }
  }

  private async onRun(run: RunInfo): Promise<void> {
    if (this.deps.cache.isStale(this.slug, run)) {
      this.deps.log.info("ignored a stale run delivery", { id: run.id, attempt: run.attempt })
      return
    }
    this.deps.cache.set(this.slug, run, this.now)

    const subscriptions = this.deps.store.list().filter((subscription) => matchesRun(subscription, run))
    if (process.env.CI_WATCH_DEBUG)
      this.deps.log.info("run delivery", {
        id: run.id,
        status: run.status,
        conclusion: run.conclusion,
        attempt: run.attempt,
        subs: subscriptions.length,
      })
    for (const subscription of subscriptions) {
      if (
        subscription.mergedAt !== undefined &&
        run.createdAt !== undefined &&
        Date.parse(run.createdAt) > subscription.mergedAt
      ) {
        await this.deps.store.save({ ...subscription, mergedAt: undefined })
      }
    }
    // A pushes-only watch on the same branch still needs the run state in the
    // dashboard, even though it never receives run notifications.
    const branchSubscriptions = this.deps.store
      .list()
      .filter((subscription) => subscription.target.type === "branch" && subscription.target.value === run.branch)
    const stateSessions = new Set(
      [...subscriptions, ...branchSubscriptions].map((subscription) => subscription.sessionID),
    )
    for (const sessionID of stateSessions) await this.refreshStatus(sessionID)
    for (const sessionID of stateSessions) this.changed(sessionID)

    if (isTerminal(run) && stateSessions.size > 0 && this.deps.jobs.forRun(run.id).length === 0) {
      await this.fetchJobs(run)
      for (const sessionID of stateSessions) this.changed(sessionID)
    }

    if (!isTerminal(run)) {
      for (const waiter of [...this.waiters]) this.considerWaiter(waiter, run)
      return
    }

    const key = `${run.id}:${run.attempt}:${run.conclusion}`
    let message: string | undefined
    if (isFailure(run)) message = await this.failureMessage(run)
    else if (isSuccess(run)) message = renderSuccess(run)
    else message = `${renderRunLine(run, this.now)}`

    for (const subscription of subscriptions) {
      if (await this.seen(`run:${subscription.id}:${key}`)) continue

      const suppressed = this.isSuppressed(subscription.sessionID, subscription.target)
      if (!suppressed && isFailure(run) && subscription.notify !== "none" && message) {
        await this.deps.notifier.wake(subscription.sessionID, message, subscription.delivery)
      }
      if (!suppressed && isSuccess(run) && subscription.notify === "all") {
        this.scheduleGreen(subscription, run.sha)
      }
    }

    for (const waiter of [...this.waiters]) this.considerWaiter(waiter, run)
  }

  private async onJob(job: JobInfo): Promise<void> {
    this.deps.jobs.set(job, this.now)
    const run = job.runId !== undefined ? this.deps.cache.get(this.slug, job.runId) : undefined
    const sessions = new Set<string>()
    for (const subscription of this.deps.store.list()) {
      const matched = run
        ? matchesRun(subscription, run) ||
          (subscription.target.type === "branch" &&
            run.branch !== "" &&
            subscription.target.value === run.branch)
        : subscription.target.type === "branch" && job.branch !== undefined && subscription.target.value === job.branch
      if (matched) sessions.add(subscription.sessionID)
    }
    for (const sessionID of sessions) await this.refreshStatus(sessionID)
    for (const sessionID of sessions) this.changed(sessionID)
    if (isJobFailure(job)) await this.notifyJobFailure(job)
  }

  /**
   * Wakes a watcher as soon as a job fails instead of waiting for the rest of the
   * workflow. The first failure in a run attempt claims the failure keys that
   * `onRun` would use, so the terminal run event does not wake the session again.
   */
  private async notifyJobFailure(job: JobInfo): Promise<void> {
    // Do not fetch a run or its log for a job no subscription follows.
    const candidates = this.deps.store.list().filter((subscription) => matchesJob(subscription, job))
    if (candidates.length === 0) return

    let run = job.runId !== undefined ? this.deps.cache.get(this.slug, job.runId) : undefined
    if (run && job.runAttempt !== undefined && job.runAttempt < run.attempt) return
    if (job.runId !== undefined && (!run || (job.runAttempt !== undefined && run.attempt !== job.runAttempt))) {
      run = await this.deps.enricher.run(job.runId).catch((error) => {
        this.deps.log.warn("cannot read the run for a failed job", { run: job.runId, error: errorMessage(error) })
        return undefined
      })
      if (run) this.deps.cache.set(this.slug, run, this.now)
    }
    if (run && job.runAttempt !== undefined && run.attempt !== job.runAttempt) {
      this.deps.log.info("ignored a failed job from an older attempt", {
        id: job.id,
        attempt: job.runAttempt,
        current: run.attempt,
      })
      return
    }
    if (run && isTerminal(run) && isSuccess(run)) return

    const parent = run ?? this.fallbackRun(job)
    if (!parent) return
    const targets: Subscription[] = []
    for (const subscription of candidates) {
      if (!(await this.claimFailure(subscription, parent))) continue
      if (subscription.notify === "none") continue
      if (this.isSuppressed(subscription.sessionID, subscription.target)) continue
      targets.push(subscription)
    }
    if (targets.length === 0) return

    let message: string
    try {
      const excerpt = await this.deps.enricher.failedLog(parent.id, job.id, this.deps.config.maxLogChars)
      message = renderJobFailure(parent, job, excerpt.text ? excerpt : undefined)
    } catch (error) {
      this.deps.log.warn("cannot read the failed job log", {
        run: parent.id,
        job: job.id,
        error: errorMessage(error),
      })
      message = renderJobFailure(parent, job)
    }
    for (const subscription of targets) {
      await this.deps.notifier.wake(subscription.sessionID, message, subscription.delivery)
    }
  }

  /** A minimal parent run when the job arrives before `workflow_run` is cached. */
  private fallbackRun(job: JobInfo): RunInfo | undefined {
    if (job.runId === undefined) return undefined
    return {
      id: job.runId,
      name: "workflow",
      branch: job.branch ?? "",
      sha: job.sha ?? "",
      event: "unknown",
      status: "in_progress",
      conclusion: null,
      attempt: job.runAttempt ?? 1,
      url: job.runUrl ?? "",
      pullRequests: [],
    }
  }

  /**
   * Claims every conclusion key a terminal failing run could use. A job
   * conclusion does not always equal the run conclusion (`timed_out` versus
   * `failure`), so claiming one key is not enough to suppress the later wake.
   */
  private async claimFailure(subscription: Subscription, run: RunInfo): Promise<boolean> {
    let claimed = false
    for (const conclusion of ["failure", "timed_out", "action_required"]) {
      if (await this.seen(`run:${subscription.id}:${run.id}:${run.attempt}:${conclusion}`)) claimed = true
    }
    return !claimed
  }

  private async onMerge(merge: MergeInfo): Promise<void> {
    for (const subscription of this.deps.store.list()) {
      if (subscription.target.type !== "branch" || subscription.target.value !== merge.head) continue
      await this.deps.store.save({ ...subscription, mergedAt: this.now })
      await this.refreshStatus(subscription.sessionID)
      this.changed(subscription.sessionID)
    }
  }

  /** True when this delivery was already handled here or by another instance. */
  private async seen(key: string): Promise<boolean> {
    if (this.delivered.has(key)) return true
    this.delivered.set(key, this.now)
    this.trimDelivered()
    if (!this.deps.ledger) return false
    try {
      return await this.deps.ledger.claim(key)
    } catch {
      return false
    }
  }

  private trimDelivered(): void {
    if (this.delivered.size <= 2000) return
    const cutoff = this.now - DAY
    for (const [key, at] of this.delivered) if (at < cutoff) this.delivered.delete(key)
    while (this.delivered.size > 2000) {
      const oldest = this.delivered.keys().next().value
      if (oldest === undefined) break
      this.delivered.delete(oldest)
    }
  }

  private async failureMessage(run: RunInfo): Promise<string> {
    const jobs = this.deps.jobs.forRun(run.id).length > 0 ? this.deps.jobs.forRun(run.id) : await this.fetchJobs(run)
    const failed = jobs.find((job) => job.conclusion === "failure" || job.conclusion === "timed_out")
    if (!failed) return renderFailure(run, jobs)
    try {
      const excerpt = await this.deps.enricher.failedLog(run.id, failed.id, this.deps.config.maxLogChars)
      return renderFailure(run, jobs, excerpt.text ? excerpt : undefined)
    } catch (error) {
      this.deps.log.warn("cannot read failed log", { run: run.id, error: errorMessage(error) })
      return renderFailure(run, jobs)
    }
  }

  private considerWaiter(waiter: Waiter, run: RunInfo): void {
    if (!targetMatchesDelivery(waiter.target, { run })) return
    if (waiter.target.type === "branch") {
      if (!waiter.sha) waiter.sha = run.sha
      if (run.sha !== waiter.sha) return
    }
    if (waiter.target.type === "sha" && run.sha.toLowerCase() !== waiter.target.value.toLowerCase()) {
      if (!run.sha.toLowerCase().startsWith(waiter.target.value.toLowerCase())) return
    }
    waiter.runs.set(run.id, run)
    const runs = [...waiter.runs.values()]
    if (!runs.every(isTerminal)) return
    if (waiter.settle) clearTimeout(waiter.settle)
    waiter.settle = setTimeout(() => {
      const settled = [...waiter.runs.values()]
      if (settled.every(isTerminal)) {
        const result = this.waitResult(settled, "completed")
        waiter.finish({ outcome: "completed", content: result.content, metadata: result.metadata })
      }
    }, this.deps.settleMs ?? SETTLE_MS)
    waiter.settle.unref()
  }

  // ---------------------------------------------------------------------------
  // session lifecycle

  async forgetSession(sessionID: string): Promise<void> {
    await this.deps.store.removeSession(sessionID)
    this.suppressed.delete(sessionID)
    this.scheduleForwarderStop()
  }

  async autoSubscribe(sessionID: string): Promise<void> {
    const branch = await this.currentBranch()
    await this.watch(sessionID, { branch, include: ["runs"] })
  }
}
