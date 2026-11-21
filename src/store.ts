import type { JobInfo, RunInfo, Target } from "./types.ts"

function timestamp(run: RunInfo): number | undefined {
  const value = run.updatedAt ?? run.createdAt ?? run.startedAt
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export type Include = "runs" | "pushes"
export type NotifyMode = "failures" | "all" | "none"
export type DeliveryMode = "queue" | "steer"

export interface Subscription {
  readonly id: string
  readonly repo: string
  readonly sessionID: string
  readonly target: Target
  readonly include: readonly Include[]
  readonly notify: NotifyMode
  readonly delivery: DeliveryMode
  readonly createdAt: number
  readonly expiresAt: number
  /** Set when the pull request for this branch merged; cleared by later activity. */
  readonly mergedAt?: number
}

export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: {
    prefix: string
    after?: string
    limit?: number
  }): Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }>
}

const PREFIX = "sub/"

function isSubscription(value: unknown): value is Subscription {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  const target = entry.target as Record<string, unknown> | undefined
  return (
    typeof entry.id === "string" &&
    typeof entry.repo === "string" &&
    typeof entry.sessionID === "string" &&
    typeof entry.expiresAt === "number" &&
    typeof entry.createdAt === "number" &&
    typeof target?.type === "string" &&
    typeof target?.value === "string" &&
    Array.isArray(entry.include) &&
    typeof entry.notify === "string" &&
    typeof entry.delivery === "string"
  )
}

export class SubscriptionStore {
  private readonly storage: StorageLike
  private readonly repo: string
  private readonly entries = new Map<string, Subscription>()

  constructor(storage: StorageLike, repo: string) {
    this.storage = storage
    this.repo = repo
  }

  private key(id: string): string {
    return `${PREFIX}${this.repo}/${id}`
  }

  async load(): Promise<void> {
    let cursor: string | undefined
    do {
      const page = await this.storage.scan({ prefix: PREFIX, after: cursor, limit: 100 })
      for (const entry of page.entries) {
        if (isSubscription(entry.value) && entry.value.repo === this.repo) {
          this.entries.set(entry.value.id, entry.value)
        }
      }
      cursor = page.next
    } while (cursor)
  }

  list(): Subscription[] {
    return [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  bySession(sessionID: string): Subscription[] {
    return this.list().filter((entry) => entry.sessionID === sessionID)
  }

  async save(subscription: Subscription): Promise<void> {
    const entry = { ...subscription, repo: this.repo }
    this.entries.set(entry.id, entry)
    await this.storage.set(this.key(entry.id), entry)
  }

  async remove(id: string): Promise<boolean> {
    if (!this.entries.delete(id)) return false
    await this.storage.remove(this.key(id))
    return true
  }

  async removeSession(sessionID: string): Promise<number> {
    const ids = this.bySession(sessionID).map((entry) => entry.id)
    for (const id of ids) await this.remove(id)
    return ids.length
  }

  async prune(now = Date.now()): Promise<number> {
    const expired = this.list().filter((entry) => entry.expiresAt <= now)
    for (const entry of expired) await this.remove(entry.id)
    return expired.length
  }

  get size(): number {
    return this.entries.size
  }
}

export class RunCache {
  private readonly runs = new Map<string, { run: RunInfo; at: number; slug: string }>()
  private readonly max: number
  private readonly ttlMs: number

  constructor(max = 400, ttlMs = 6 * 60 * 60 * 1000) {
    this.max = max
    this.ttlMs = ttlMs
  }

  private key(slug: string, id: number): string {
    return `${slug}#${id}`
  }

  set(slug: string, run: RunInfo, now = Date.now()): void {
    if (this.isStale(slug, run)) return
    this.runs.delete(this.key(slug, run.id))
    this.runs.set(this.key(slug, run.id), { run, at: now, slug })
    this.trim(now)
  }

  get(slug: string, id: number): RunInfo | undefined {
    return this.runs.get(this.key(slug, id))?.run
  }

  /**
   * True when `run` describes an older attempt (or an older snapshot of the same
   * attempt) than the one already cached. A late webhook for attempt 1 must not
   * overwrite — or be notified over — attempt 2.
   */
  isStale(slug: string, run: RunInfo): boolean {
    const current = this.runs.get(this.key(slug, run.id))?.run
    if (!current) return false
    if (run.attempt < current.attempt) return true
    if (run.attempt > current.attempt) return false
    const incoming = timestamp(run)
    const known = timestamp(current)
    return incoming !== undefined && known !== undefined && incoming < known
  }

  forBranch(slug: string, branch: string, limit = 5): RunInfo[] {
    return [...this.runs.values()]
      .filter((entry) => entry.slug === slug && entry.run.branch === branch)
      .map((entry) => entry.run)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
  }

  forSha(slug: string, sha: string, limit = 5): RunInfo[] {
    const wanted = sha.toLowerCase()
    return [...this.runs.values()]
      .filter((entry) => entry.slug === slug && entry.run.sha.toLowerCase().startsWith(wanted))
      .map((entry) => entry.run)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
  }

  private trim(now: number): void {
    for (const [key, entry] of this.runs) {
      if (now - entry.at > this.ttlMs) this.runs.delete(key)
    }
    while (this.runs.size > this.max) {
      const oldest = this.runs.keys().next().value
      if (oldest === undefined) break
      this.runs.delete(oldest)
    }
  }
}

export class JobCache {
  private readonly runs = new Map<number, { order: Map<number, number>; jobs: Map<number, JobInfo> }>()
  private readonly touched = new Map<number, number>()
  private readonly max: number
  private readonly ttlMs: number

  constructor(max = 200, ttlMs = 6 * 60 * 60 * 1000) {
    this.max = max
    this.ttlMs = ttlMs
  }

  set(job: JobInfo, now = Date.now()): void {
    if (job.runId === undefined) return
    const bucket = this.runs.get(job.runId) ?? { order: new Map<number, number>(), jobs: new Map<number, JobInfo>() }
    if (!bucket.jobs.has(job.id)) bucket.order.set(job.id, bucket.order.size)
    bucket.jobs.set(job.id, job)
    this.runs.set(job.runId, bucket)
    this.touched.set(job.runId, now)
    this.trim(now)
  }

  replace(runId: number, jobs: readonly JobInfo[], now = Date.now()): void {
    const order = new Map<number, number>()
    const map = new Map<number, JobInfo>()
    jobs.forEach((job, index) => {
      order.set(job.id, index)
      map.set(job.id, job)
    })
    this.runs.set(runId, { order, jobs: map })
    this.touched.set(runId, now)
    this.trim(now)
  }

  /** Workflow order, as returned by the jobs API. */
  forRun(runId: number): JobInfo[] {
    const bucket = this.runs.get(runId)
    if (!bucket) return []
    return [...bucket.jobs.values()].sort(
      (left, right) => (bucket.order.get(left.id) ?? 0) - (bucket.order.get(right.id) ?? 0),
    )
  }

  get size(): number {
    return this.runs.size
  }

  private trim(now: number): void {
    for (const [runId, at] of this.touched) {
      if (now - at > this.ttlMs) {
        this.touched.delete(runId)
        this.runs.delete(runId)
      }
    }
    while (this.touched.size > this.max) {
      const oldest = this.touched.keys().next().value
      if (oldest === undefined) break
      this.touched.delete(oldest)
      this.runs.delete(oldest)
    }
  }
}

const SEEN_PREFIX = "seen/"
const SEEN_TTL = 24 * 60 * 60 * 1000

/**
 * Cross-process delivery ledger. Two opencode processes can load this plugin for
 * the same repository (a long-running server plus the service), and their in-memory
 * dedupe maps are independent, so the same push or green wake would reach a session
 * once per process. Plugin storage is shared by plugin id, so a claim recorded there
 * stops the duplicates.
 */
export class DeliveryLedger {
  private readonly storage: StorageLike
  private readonly repo: string
  private readonly now: () => number
  private readonly local = new Map<string, number>()

  constructor(storage: StorageLike, repo: string, now: () => number = Date.now) {
    this.storage = storage
    this.repo = repo
    this.now = now
  }

  /** True when another instance already handled this delivery key. */
  async claim(key: string): Promise<boolean> {
    const at = this.now()
    const full = `${SEEN_PREFIX}${this.repo}/${key}`
    try {
      const existing = await this.storage.get(full)
      if (isFresh(existing, at)) return true
      await this.storage.set(full, { at })
      return false
    } catch {
      // A broken ledger must never swallow a wake.
      if (isFresh(this.local.get(full), at)) return true
      this.local.set(full, at)
      return false
    }
  }
}

function isFresh(value: unknown, at: number): boolean {
  if (typeof value === "number") return at - value < SEEN_TTL
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.at === "number" && at - entry.at < SEEN_TTL
}
