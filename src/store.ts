import type { RunInfo, Target } from "./types.ts"

export type Include = "runs" | "pushes"
export type NotifyMode = "failures" | "all" | "none"
export type DeliveryMode = "queue" | "steer"

export interface Subscription {
  readonly id: string
  readonly sessionID: string
  readonly target: Target
  readonly include: readonly Include[]
  readonly notify: NotifyMode
  readonly delivery: DeliveryMode
  readonly createdAt: number
  readonly expiresAt: number
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
  private readonly entries = new Map<string, Subscription>()

  constructor(storage: StorageLike) {
    this.storage = storage
  }

  async load(): Promise<void> {
    let cursor: string | undefined
    do {
      const page = await this.storage.scan({ prefix: PREFIX, after: cursor, limit: 100 })
      for (const entry of page.entries) {
        if (isSubscription(entry.value)) this.entries.set(entry.value.id, entry.value)
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
    this.entries.set(subscription.id, subscription)
    await this.storage.set(`${PREFIX}${subscription.id}`, subscription)
  }

  async remove(id: string): Promise<boolean> {
    if (!this.entries.delete(id)) return false
    await this.storage.remove(`${PREFIX}${id}`)
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
    this.runs.delete(this.key(slug, run.id))
    this.runs.set(this.key(slug, run.id), { run, at: now, slug })
    this.trim(now)
  }

  get(slug: string, id: number): RunInfo | undefined {
    return this.runs.get(this.key(slug, id))?.run
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
