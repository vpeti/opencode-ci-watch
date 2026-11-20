import assert from "node:assert/strict"
import test from "node:test"
import type { Config } from "../src/config.js"
import type { Enricher } from "../src/github/enrich.js"
import type { Notifier } from "../src/notify.js"
import type { Forwarder } from "../src/forwarder.js"
import { CiService } from "../src/service.js"
import { RunCache, SubscriptionStore, type StorageLike } from "../src/store.js"
import type { Logger } from "../src/types.js"
import { job, pushPayload, run, workflowRunPayload } from "./helpers.js"
import { normalizeDelivery } from "../src/events.js"

const silent: Logger = { info() {}, warn() {}, error() {} }

const config: Config = {
  disabled: false,
  host: "github.com",
  notify: { success: false, delivery: "queue" },
  autoSubscribe: { onPush: false },
  forwarder: { idleTimeoutMinutes: 30, restartMax: 5 },
  maxLogChars: 1200,
  waitTimeoutSeconds: 300,
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

function harness(options: { recent?: () => Promise<ReturnType<typeof run>[]> } = {}) {
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

  const store = new SubscriptionStore(storage())
  const service = new CiService({
    repo: { owner: "acme", name: "widgets", slug: "acme/widgets" },
    config,
    enricher,
    store,
    cache: new RunCache(),
    notifier,
    forwarder,
    log: silent,
    currentBranch: async () => "main",
    now: () => 1_000_000,
  })
  return { service, store, statuses, wakes, starts: () => starts }
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
  assert.match(h.statuses.get("ses_1") ?? "", /✅ r1002/)
})

test("notify: all wakes on success", async () => {
  const h = harness()
  await h.service.watch("ses_1", { branch: "main", notify: "all" })
  const delivery = normalizeDelivery("workflow_run", workflowRunPayload({ id: 1003, conclusion: "success" }))
  assert.ok(delivery)
  await h.service.onDelivery(delivery)
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
