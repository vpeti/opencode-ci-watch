import { randomUUID } from "node:crypto"
import type { Config } from "./config.js"
import { isFailure, isTerminal, isSuccess } from "./events.js"
import type { Enricher } from "./github/enrich.js"
import type { Forwarder } from "./forwarder.js"
import { errorMessage } from "./log.js"
import { describeTarget, matchesPush, matchesRun, targetKey, targetMatchesDelivery } from "./match.js"
import type { Notifier } from "./notify.js"
import {
  conclusionEmoji,
  relativeTime,
  renderFailure,
  renderJobs,
  renderPush,
  renderRunLine,
  renderSuccess,
} from "./render.js"
import type { DeliveryMode, Include, NotifyMode, RunCache, Subscription, SubscriptionStore } from "./store.js"
import type { Delivery, JobInfo, Logger, PushInfo, RepoRef, RunInfo, Target } from "./types.js"

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
  readonly notifier: Notifier
  readonly forwarder: Forwarder
  readonly log: Logger
  readonly currentBranch: () => Promise<string | undefined>
  readonly now?: () => number
  readonly id?: () => string
}

interface Waiter {
  readonly id: string
  readonly sessionID: string
  readonly target: Target
  sha: string | undefined
  readonly runs: Map<number, RunInfo>
  readonly startedAt: number
  settle: NodeJS.Timeout | undefined
  finish: (result: ToolResult & { outcome: string }) => void
}

const DAY = 24 * 60 * 60 * 1000
const MAX_STATUS_LINES = 6
const SETTLE_MS = 15_000

export class CiService {
  private readonly deps: ServiceDeps
  private readonly waiters = new Set<Waiter>()
  private readonly suppressed = new Map<string, Set<string>>()
  private readonly notified = new Map<string, number>()
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
    if (this.deps.store.size > 0) await this.ensureForwarder()
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    for (const waiter of this.waiters) {
      if (waiter.settle) clearTimeout(waiter.settle)
      waiter.finish({ outcome: "cancelled", content: "ci wait cancelled: the plugin is shutting down", metadata: {} })
    }
    this.waiters.clear()
    await this.deps.forwarder.stop()
  }

  health(): string | undefined {
    const state = this.deps.forwarder.state
    if (state === "running" || state === "starting") return undefined
    if (state === "stopped" && this.deps.store.size === 0) return undefined
    const detail = this.deps.forwarder.lastError
    return `⚠️ ci event stream: ${state}${detail ? ` (${detail})` : ""}`
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

  private latestRun(target: Target): RunInfo | undefined {
    const base = this.deps.cache
    if (target.type === "branch") return base.forBranch(this.slug, target.value, 1)[0]
    if (target.type === "sha") return base.forSha(this.slug, target.value, 1)[0]
    return base.get(this.slug, Number(target.value))
  }

  // ---------------------------------------------------------------------------
  // subscriptions

  async watch(sessionID: string, input: WatchInput): Promise<ToolResult> {
    const target = await this.resolveTarget(input)
    const requested = (input.include ?? []).filter((entry): entry is Include => entry === "runs" || entry === "pushes")
    const include = requested.length > 0 ? [...new Set(requested)] : (["runs"] as Include[])
    const notify: NotifyMode = input.notify === "all" || input.notify === "none" ? input.notify : "failures"
    const delivery: DeliveryMode = input.delivery === "steer" ? "steer" : this.deps.config.notify.delivery
    const ttlMinutes = Math.min(7 * 24 * 60, Math.max(5, input.ttlMinutes ?? 24 * 60))
    const expiresAt = this.now + ttlMinutes * 60 * 1000

    const existing = this.deps.store
      .bySession(sessionID)
      .find((entry) => targetKey(entry.target) === targetKey(target) && entry.include.join(",") === include.join(","))

    const subscription: Subscription = existing
      ? { ...existing, expiresAt }
      : {
          id: this.deps.id?.() ?? randomUUID().slice(0, 8),
          sessionID,
          target,
          include,
          notify,
          delivery,
          createdAt: this.now,
          expiresAt,
        }
    await this.deps.store.save(subscription)
    await this.ensureForwarder()
    await this.refreshStatus(sessionID)
    void this.reconcile(target).catch((error) => this.deps.log.warn(`cannot reconcile ${targetKey(target)}`, { error: errorMessage(error) }))

    const latest = this.latestRun(target)
    const status = latest ? `${conclusionEmoji(latest.conclusion)} r${latest.id}` : "no runs seen yet"
    return {
      content: `👀 watching ${describeTarget(target)} (${include.join("+")}) · ${status} · id ${subscription.id}`,
      metadata: { id: subscription.id, target, include, notify: subscription.notify, sessionID },
    }
  }

  async unwatch(sessionID: string, input: { id?: string; branch?: string; sha?: string; run?: number; all?: boolean }): Promise<ToolResult> {
    if (input.all) {
      const removed = await this.deps.store.removeSession(sessionID)
      await this.refreshStatus(sessionID)
      this.scheduleForwarderStop()
      return { content: removed === 0 ? "nothing to unwatch" : `👋 stopped watching ${removed} target(s)`, metadata: { removed } }
    }
    if (input.id) {
      const sub = this.deps.store.list().find((entry) => entry.id === input.id && entry.sessionID === sessionID)
      if (!sub) throw new CiError(`no subscription "${input.id}" for this session`)
      await this.deps.store.remove(sub.id)
      await this.refreshStatus(sessionID)
      this.scheduleForwarderStop()
      return { content: `👋 stopped watching ${describeTarget(sub.target)}`, metadata: { removed: 1 } }
    }

    const target = await this.resolveTarget(input)
    const matches = this.deps.store
      .bySession(sessionID)
      .filter((entry) => targetKey(entry.target) === targetKey(target))
    for (const entry of matches) await this.deps.store.remove(entry.id)
    await this.refreshStatus(sessionID)
    this.scheduleForwarderStop()
    return {
      content: matches.length === 0 ? `was not watching ${describeTarget(target)}` : `👋 stopped watching ${describeTarget(target)}`,
      metadata: { removed: matches.length },
    }
  }

  private async reconcile(target: Target): Promise<void> {
    if (target.type === "branch") {
      const runs = await this.deps.enricher.recentRuns(target.value, 10)
      for (const run of runs) this.deps.cache.set(this.slug, run, this.now)
      const sessions = new Set(
        this.deps.store
          .list()
          .filter((entry) => entry.target.type === "branch" && entry.target.value === target.value)
          .map((entry) => entry.sessionID),
      )
      for (const sessionID of sessions) await this.refreshStatus(sessionID)
      return
    }
    if (target.type === "sha") {
      const runs = await this.deps.enricher.runsForSha(target.value, 10)
      for (const run of runs) this.deps.cache.set(this.slug, run, this.now)
      return
    }
    const run = await this.deps.enricher.run(Number(target.value))
    if (run) this.deps.cache.set(this.slug, run, this.now)
  }

  async refreshStatus(sessionID: string): Promise<void> {
    const subs = this.deps.store.bySession(sessionID)
    if (subs.length === 0) {
      await this.deps.notifier.setStatus(sessionID, undefined)
      return
    }
    const lines: string[] = []
    for (const sub of subs.slice(0, MAX_STATUS_LINES)) {
      const latest = this.latestRun(sub.target)
      const marker = sub.include.includes("pushes") && !sub.include.includes("runs") ? "⤴️" : conclusionEmoji(latest?.conclusion ?? null)
      const detail = latest
        ? `${marker} r${latest.id} ${relativeTime(latest.updatedAt ?? latest.createdAt, this.now)}`.trim()
        : "no runs yet"
      const modes = [sub.include.includes("runs") ? "runs" : undefined, sub.include.includes("pushes") ? "pushes" : undefined]
        .filter(Boolean)
        .join("+")
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
      return { content: `no workflow runs found for ${describeTarget(target)}`, metadata: { target, runs: [] } }
    }

    const lines: string[] = []
    const metadata: Array<Record<string, unknown>> = []
    for (const run of runs.slice(0, input.recent ?? 3)) {
      lines.push(renderRunLine(run, this.now))
      let jobs: JobInfo[] = []
      if (withJobs || (withLogs && isFailure(run))) {
        try {
          jobs = await this.deps.enricher.jobs(run.id)
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
        finish: (result) => {
          if (waiter.settle) clearTimeout(waiter.settle)
          clearTimeout(timer)
          this.waiters.delete(waiter)
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
    else await this.onPush(delivery.push)
  }

  private async onPush(push: PushInfo): Promise<void> {
    for (const subscription of this.deps.store.list()) {
      if (!matchesPush(subscription, push)) continue
      await this.refreshStatus(subscription.sessionID)
      if (this.isSuppressed(subscription.sessionID, subscription.target)) continue
      await this.deps.notifier.wake(subscription.sessionID, renderPush(push), subscription.delivery)
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.target.type !== "branch" || waiter.target.value !== push.branch) continue
      if (!waiter.sha) waiter.sha = push.after
    }
  }

  private async onRun(run: RunInfo): Promise<void> {
    this.deps.cache.set(this.slug, run, this.now)

    const subscriptions = this.deps.store.list().filter((subscription) => matchesRun(subscription, run))
    const sessions = new Set(subscriptions.map((subscription) => subscription.sessionID))
    for (const sessionID of sessions) await this.refreshStatus(sessionID)

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
      const dedupe = `${subscription.id}:${key}`
      if (this.notified.has(dedupe)) continue
      this.notified.set(dedupe, this.now)
      this.trimNotified()

      const shouldWake =
        !this.isSuppressed(subscription.sessionID, subscription.target) &&
        subscription.notify !== "none" &&
        (isFailure(run) || subscription.notify === "all" || (isSuccess(run) && this.deps.config.notify.success))

      if (shouldWake && message) {
        await this.deps.notifier.wake(subscription.sessionID, message, subscription.delivery)
      }
    }

    for (const waiter of [...this.waiters]) this.considerWaiter(waiter, run)
  }

  private trimNotified(): void {
    if (this.notified.size <= 2000) return
    const cutoff = this.now - DAY
    for (const [key, at] of this.notified) if (at < cutoff) this.notified.delete(key)
    while (this.notified.size > 2000) {
      const oldest = this.notified.keys().next().value
      if (oldest === undefined) break
      this.notified.delete(oldest)
    }
  }

  private async failureMessage(run: RunInfo): Promise<string> {
    let jobs: JobInfo[] = []
    try {
      jobs = await this.deps.enricher.jobs(run.id)
    } catch (error) {
      this.deps.log.warn("cannot read job results", { run: run.id, error: errorMessage(error) })
    }
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
    }, SETTLE_MS)
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
    await this.watch(sessionID, { branch, include: ["runs"], notify: "failures" })
  }
}
