import assert from "node:assert/strict"
import test from "node:test"
import type { Config } from "../src/config.ts"
import type { Enricher } from "../src/github/enrich.ts"
import type { Notifier } from "../src/notify.ts"
import type { Forwarder } from "../src/forwarder.ts"
import { CiService } from "../src/service.ts"
import { JobCache, RunCache, SubscriptionStore, type StorageLike } from "../src/store.ts"
import type { Logger } from "../src/types.ts"
import { assertNoNulls, job, mergePayload, pushPayload, run, workflowJobPayload, workflowRunPayload } from "./helpers.ts"
import { normalizeDelivery } from "../src/events.ts"

const silent: Logger = { info() {}, warn() {}, error() {} }

const baseConfig: Config = {
  disabled: false,
  host: "github.com",
  notify: { success: false, delivery: "queue" },
  autoSubscribe: { onPush: false },
  forwarder: { idleTimeoutMinutes: 30, restartMax: 5 },
  maxLogChars: 1200,
  waitTimeoutSeconds: 300,
  agents: {},
}

function storage(): StorageLike {
  const data = new Map<string, unknown>()
  return {
    async get(key) {
      return data.get(key)
    },
    async set(key, value) {
      data.set(key, value)
    },
    async remove(key) {
      data.delete(key)
    },
    async scan({ prefix, after, limit = 100 }) {
      const keys = [...data.keys()].filter((key) => key.startsWith(prefix)).sort()
      const start = after ? keys.indexOf(after) + 1 : 0
      return {
        entries: keys.slice(start, start + limit).map((key) => ({ key, value: data.get(key) })),
        next: start + limit < keys.length ? keys[start + limit - 1] : undefined,
      }
    },
  }
}

function harness(options: { recent?: () => Promise<ReturnType<typeof run>[]>; notifySuccess?: boolean; greenSettleMs?: number } = {}) {
  const config: Config = {
    ...baseConfig,
    notify: { ...baseConfig.notify, success: options.notifySuccess ?? false },
  }
  const statuses = new Map<string, string | undefined>()
  const wakes: Array<{ sessionID: string; text: string }> = []
  const notifier = {
    async setStatus(sessionID: string, text: string | undefined) {
      statuses.set(sessionID, text)
    },
    async wake(sessionID: string, text: string) {
      wakes.push({ sessionID, text })
      return true
    },
  } as unknown as Notifier

  const enricher = {
    async jobs() {
      return [job(), job({ id: 5002, name: "lint", conclusion: "success", steps: [] })]
    },
    async failedLog() {
      return { text: "error[E0308]: mismatched types", job: "test", step: "cargo test" }
    },
    async run() {
      return run()
    },
    async recentRuns() {
      return options.recent ? await options.recent() : []
    },
    async runsForSha() {
      return []
    },
  } as unknown as Enricher

  let starts = 0
  const forwarder = {
    state: "stopped",
    lastError: undefined,
    async start() {
      starts += 1
    },
    async stop() {},
  } as unknown as Forwarder

  const changes: string[] = []
  const store = new SubscriptionStore(storage(), "acme/widgets")
  const jobs = new JobCache()
  const service = new CiService({
    repo: { owner: "acme", name: "widgets", slug: "acme/widgets" },
    config,
    enricher,
    store,
    cache: new RunCache(),
    jobs,
    defaultBranch: "main",
    notifier,
    forwarder,
    log: silent,
    currentBranch: async () => "main",
    now: () => 1_000_000,
    greenSettleMs: options.greenSettleMs,
    onStateChanged: (sessionID: string) => changes.push(sessionID),
  })
  return { service, store, jobs, statuses, wakes, changes, starts: () => starts }
}

test("watching starts the forwarder and writes the status entry", async () => {
  const h = harness()
  const result = await h.service.watch("ses_1", { branch: "main" })
  assert.match(result.content, /👀 watching main/)
  assert.equal(h.store.size, 1)
  assert.equal(h.starts(), 1)
  assert.match(h.statuses.get("ses_1") ?? "", /👀 main/)
})

test("a failed run wakes the session with the failing job and log", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "main" })

  const delivery = normalizeDelivery("workflow_run", workflowRunPayload({ conclusion: "failure" }))
  assert.ok(delivery)
  await h.service.onDelivery(delivery)

  assert.equal(h.wakes.length, 1)
  assert.match(h.wakes[0]!.text, /^❌ ci main · r1001 · 1\/2 jobs failed/)
  assert.match(h.wakes[0]!.text, /step "cargo test"/)
  assert.match(h.wakes[0]!.text, /error\[E0308\]/)
})

test("the same run is only delivered once", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "main" })
  const delivery = normalizeDelivery("workflow_run", workflowRunPayload({ conclusion: "failure" }))
  assert.ok(delivery)
  await h.service.onDelivery(delivery)
  await h.service.onDelivery(delivery)
  assert.equal(h.wakes.length, 1)
})

test("a green run updates the status line without waking by default", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "main" })
  const delivery = normalizeDelivery("workflow_run", workflowRunPayload({ id: 1002, conclusion: "success" }))
  assert.ok(delivery)
  await h.service.onDelivery(delivery)
  assert.equal(h.wakes.length, 0)
  assert.match(h.statuses.get("ses_1") ?? "", /✅ 1 passed/)
})

test("notify: all wakes on success", async () => {
  const h = harness({ greenSettleMs: 0 })
  await h.service.watch("ses_1", { branch: "main", notify: "all" })
  const delivery = normalizeDelivery("workflow_run", workflowRunPayload({ id: 1003, conclusion: "success" }))
  assert.ok(delivery)
  await h.service.onDelivery(delivery)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(h.wakes.length, 1)
  assert.match(h.wakes[0]!.text, /^✅/)
})

test("push-only subscriptions receive merges and nothing else", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "main", include: ["pushes"] })

  const runDelivery = normalizeDelivery("workflow_run", workflowRunPayload({ conclusion: "failure" }))
  assert.ok(runDelivery)
  await h.service.onDelivery(runDelivery)
  assert.equal(h.wakes.length, 0)

  const push = normalizeDelivery("push", pushPayload())
  assert.ok(push)
  await h.service.onDelivery(push)
  assert.equal(h.wakes.length, 1)
  assert.match(h.wakes[0]!.text, /^⤴️ main · b1b2c3d/)
})

test("unwatch all removes subscriptions and clears the status entry", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "main" })
  const result = await h.service.unwatch("ses_1", { all: true })
  assert.match(result.content, /stopped watching 1/)
  assert.equal(h.store.size, 0)
  assert.equal(h.statuses.get("ses_1"), undefined)
})

test("a quick green workflow does not hide a still-running one on the same commit", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "main" })

  const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
  const merge = normalizeDelivery("workflow_run", workflowRunPayload({ id: 2002, name: "Auto-merge", conclusion: "success" }))
  const pending = normalizeDelivery("workflow_run", {
    ...workflowRunPayload({ id: 2001, name: "CI", conclusion: null }),
    workflow_run: { ...workflowRunPayload({ id: 2001, name: "CI", conclusion: null }).workflow_run, status: "queued" },
  })
  assert.ok(merge && pending)
  await h.service.onDelivery(merge)
  await h.service.onDelivery(pending)

  const status = h.statuses.get("ses_1") ?? ""
  assert.match(status, /○ 1 queued/)
  assert.match(status, /✅ 1 passed/)
  assert.doesNotMatch(status, /✅ 2 passed/)
  assert.match(status, new RegExp(sha.slice(0, 7)))
})

test("notify.success makes the default subscription wait for every run to be green", async () => {
  const h = harness({ notifySuccess: true, greenSettleMs: 0 })
  await h.service.watch("ses_1", { branch: "main" })
  assert.equal(h.store.list()[0]?.notify, "all")

  const pending = normalizeDelivery("workflow_run", workflowRunPayload({ id: 2001, name: "CI", conclusion: null, status: "queued" }))
  const merge = normalizeDelivery("workflow_run", workflowRunPayload({ id: 2002, name: "Auto-merge", conclusion: "success" }))
  assert.ok(pending && merge)
  await h.service.onDelivery(pending)
  await h.service.onDelivery(merge)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(h.wakes.length, 0)

  const ci = normalizeDelivery("workflow_run", workflowRunPayload({ id: 2001, name: "CI", conclusion: "success" }))
  assert.ok(ci)
  await h.service.onDelivery(ci)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(h.wakes.length, 1)
  assert.match(h.wakes[0]!.text, /^✅ main · 2 passed/)
})

test("a green run from an older commit does not wake after a newer push", async () => {
  const h = harness({ notifySuccess: true, greenSettleMs: 0 })
  await h.service.watch("ses_1", { branch: "main" })
  const olderSha = "a".repeat(40)
  const newerSha = "b".repeat(40)

  const older = normalizeDelivery(
    "workflow_run",
    workflowRunPayload({ id: 3001, conclusion: "success", head_sha: olderSha, created_at: "2026-11-20T10:00:00Z" }),
  )
  const pending = normalizeDelivery(
    "workflow_run",
    workflowRunPayload({
      id: 3002,
      status: "queued",
      conclusion: null,
      head_sha: newerSha,
      created_at: "2026-11-20T10:05:00Z",
    }),
  )
  assert.ok(older && pending)
  await h.service.onDelivery(older)
  await h.service.onDelivery(pending)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(h.wakes.length, 0)

  const newer = normalizeDelivery(
    "workflow_run",
    workflowRunPayload({
      id: 3002,
      conclusion: "success",
      head_sha: newerSha,
      created_at: "2026-11-20T10:05:00Z",
    }),
  )
  assert.ok(newer)
  await h.service.onDelivery(newer)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(h.wakes.length, 1)
  assert.match(h.wakes[0]!.text, /^✅ main · 1 passed/)
  assert.doesNotMatch(h.wakes[0]!.text, /⏳/)
})

test("the dashboard state carries the run and its jobs", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "feature/login" })

  const runDelivery = normalizeDelivery(
    "workflow_run",
    workflowRunPayload({ status: "in_progress", conclusion: null, head_branch: "feature/login" }),
  )
  const jobDelivery = normalizeDelivery("workflow_job", workflowJobPayload({ head_branch: "feature/login" }))
  assert.ok(runDelivery && jobDelivery)
  await h.service.onDelivery(runDelivery)
  await h.service.onDelivery(jobDelivery)

  const state = await h.service.state("ses_1")
  assert.equal(state.defaultBranch, "main")
  assert.equal(state.watches.length, 1)
  assert.equal(state.watches[0]?.run?.id, 1001)
  assert.equal(state.watches[0]?.runs.length, 1)
  assert.equal(state.watches[0]?.runs[0]?.primary, true)
  assert.equal(state.watches[0]?.jobs[0]?.name, "test")
  assert.equal(state.watches[0]?.jobs[0]?.startedAt, "2026-11-20T10:00:05Z")
  assert.ok(h.changes.includes("ses_1"))
})

test("a merge marks the branch and clears it on later activity", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "feature/login" })
  const merge = normalizeDelivery("pull_request", mergePayload())
  assert.ok(merge)
  await h.service.onDelivery(merge)

  let state = await h.service.state("ses_1")
  assert.equal(state.watches[0]?.merged, true)
  assert.ok(state.watches[0]?.mergedAt)

  await h.service.watch("ses_1", { branch: "feature/login" })
  state = await h.service.state("ses_1")
  assert.equal(state.watches[0]?.merged, false)
})

test("a pushes-only watch still receives the branch run state", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "main", include: ["pushes"] })
  const delivery = normalizeDelivery("workflow_run", workflowRunPayload({ status: "in_progress", conclusion: null }))
  assert.ok(delivery)
  await h.service.onDelivery(delivery)

  const state = await h.service.state("ses_1")
  assert.equal(state.watches[0]?.run?.id, 1001)
  assert.equal(state.watches[0]?.run?.status, "in_progress")
})

test("unwatch notifies state observers", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "main" })
  h.changes.length = 0

  await h.service.unwatch("ses_1", { branch: "main" })
  assert.ok(h.changes.includes("ses_1"))
  assert.equal((await h.service.state("ses_1")).watches.length, 0)
})

test("the dashboard prefers a failed run over a newer skipped workflow", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "feature/login" })

  const ci = normalizeDelivery(
    "workflow_run",
    workflowRunPayload({ id: 2001, name: "CI", conclusion: "failure", head_branch: "feature/login" }),
  )
  const auto = normalizeDelivery(
    "workflow_run",
    workflowRunPayload({ id: 2002, name: "Auto-merge", conclusion: "success", head_branch: "feature/login" }),
  )
  const jobDelivery = normalizeDelivery("workflow_job", workflowJobPayload({ run_id: 2001, head_branch: "feature/login" }))
  assert.ok(ci && auto && jobDelivery)
  await h.service.onDelivery(ci)
  await h.service.onDelivery(auto)
  await h.service.onDelivery(jobDelivery)

  const state = await h.service.state("ses_1")
  assert.equal(state.watches[0]?.run?.name, "CI")
  assert.equal(state.watches[0]?.runs.length, 2)
  assert.equal(state.watches[0]?.runs[0]?.name, "CI")
  assert.equal(state.watches[0]?.runs[0]?.primary, true)
  assert.equal(state.watches[0]?.runs[1]?.name, "Auto-merge")
  assert.equal(state.watches[0]?.runs[1]?.primary, false)
  assert.ok((state.watches[0]?.jobs.length ?? 0) > 0)
})

test("the dashboard ignores manual and scheduled runs on a branch", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "main" })

  const manual = normalizeDelivery(
    "workflow_run",
    workflowRunPayload({ id: 3001, name: "Runner maintenance", event: "workflow_dispatch", conclusion: "success" }),
  )
  assert.ok(manual)
  await h.service.onDelivery(manual)

  const state = await h.service.state("ses_1")
  assert.equal(state.watches[0]?.runs.length, 0)
})

test("the CI workflow stays primary and secondaries sort by name", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "main" })

  const ci = normalizeDelivery("workflow_run", workflowRunPayload({ id: 4001, name: "CI", conclusion: "success" }))
  const auto = normalizeDelivery(
    "workflow_run",
    workflowRunPayload({ id: 4002, name: "Auto-merge", conclusion: "success" }),
  )
  assert.ok(ci && auto)
  await h.service.onDelivery(auto)
  await h.service.onDelivery(ci)

  const state = await h.service.state("ses_1")
  assert.equal(state.watches[0]?.runs[0]?.name, "CI")
  assert.equal(state.watches[0]?.runs[0]?.primary, true)
  assert.equal(state.watches[0]?.runs[1]?.name, "Auto-merge")
  assert.equal(state.watches[0]?.runs[1]?.primary, false)
})

test("a queued run with a running job reads as running", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "main" })

  const runDelivery = normalizeDelivery(
    "workflow_run",
    workflowRunPayload({ id: 5000, name: "CI", status: "queued", conclusion: null }),
  )
  const jobDelivery = normalizeDelivery("workflow_job", workflowJobPayload({ run_id: 5000 }))
  assert.ok(runDelivery && jobDelivery)
  await h.service.onDelivery(runDelivery)
  await h.service.onDelivery(jobDelivery)

  const status = h.statuses.get("ses_1") ?? ""
  assert.match(status, /⏳ 1 running/)
  assert.doesNotMatch(status, /queued/)
})

test("the dashboard state omits null timestamps", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "main" })

  const delivery = normalizeDelivery("workflow_run", workflowRunPayload({ id: 1001, name: "CI", conclusion: "success" }))
  assert.ok(delivery)
  await h.service.onDelivery(delivery)

  // gh returns null for a timestamp the job has not reached; the cache must not leak it.
  h.jobs.set({ ...job({ runId: 1001 }), startedAt: null, completedAt: null } as never, 1_000_000)

  const state = await h.service.state("ses_1")
  assertNoNulls(state)
  assert.equal(state.watches[0]?.jobs[0]?.startedAt, undefined)
  assert.equal(state.watches[0]?.jobs[0]?.completedAt, undefined)
})
