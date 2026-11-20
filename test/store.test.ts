import assert from "node:assert/strict"
import test from "node:test"
import { DeliveryLedger, RunCache, SubscriptionStore, type StorageLike } from "../src/store.ts"
import { run } from "./helpers.ts"

function memoryStorage(): StorageLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
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
      const slice = keys.slice(start, start + limit)
      const next = start + limit < keys.length ? keys[start + limit - 1] : undefined
      return { entries: slice.map((key) => ({ key, value: data.get(key) })), next }
    },
  }
}

test("stores subscriptions durably and reloads them", async () => {
  const storage = memoryStorage()
  const store = new SubscriptionStore(storage, "acme/widgets")
  await store.save({
    id: "abc",
    repo: "acme/widgets",
    sessionID: "ses_1",
    target: { type: "branch", value: "main" },
    include: ["runs"],
    notify: "failures",
    delivery: "queue",
    createdAt: 1,
    expiresAt: 10,
  })

  const reloaded = new SubscriptionStore(storage, "acme/widgets")
  await reloaded.load()
  assert.equal(reloaded.list().length, 1)
  assert.equal(reloaded.bySession("ses_1")[0]?.target.value, "main")
})

test("prunes expired subscriptions", async () => {
  const store = new SubscriptionStore(memoryStorage(), "acme/widgets")
  await store.save({
    id: "old",
    repo: "acme/widgets",
    sessionID: "ses_1",
    target: { type: "branch", value: "main" },
    include: ["runs"],
    notify: "failures",
    delivery: "queue",
    createdAt: 1,
    expiresAt: 5,
  })
  assert.equal(await store.prune(10), 1)
  assert.equal(store.size, 0)
})

test("run cache keeps runs per repository and branch", () => {
  const cache = new RunCache()
  cache.set("acme/widgets", run({ id: 1, branch: "main" }), 1)
  cache.set("acme/widgets", run({ id: 2, branch: "main" }), 1)
  cache.set("other/repo", run({ id: 3, branch: "main" }), 1)

  assert.deepEqual(
    cache.forBranch("acme/widgets", "main").map((entry) => entry.id),
    [2, 1],
  )
  assert.equal(cache.forBranch("other/repo", "main").length, 1)
  assert.equal(cache.forSha("acme/widgets", "a1b2c3d").length, 2)
  assert.equal(cache.get("acme/widgets", 1)?.id, 1)
})

test("keeps subscriptions scoped to their repository", async () => {
  const storage = memoryStorage()
  const widgets = new SubscriptionStore(storage, "acme/widgets")
  const other = new SubscriptionStore(storage, "acme/other")

  await widgets.save({
    id: "widgets",
    repo: "acme/widgets",
    sessionID: "ses_1",
    target: { type: "branch", value: "main" },
    include: ["runs"],
    notify: "failures",
    delivery: "queue",
    createdAt: 1,
    expiresAt: 10,
  })
  await storage.set("sub/legacy", {
    id: "legacy",
    sessionID: "ses_1",
    target: { type: "branch", value: "main" },
    include: ["runs"],
    notify: "failures",
    delivery: "queue",
    createdAt: 1,
    expiresAt: 10,
  })

  await other.load()
  assert.equal(other.list().length, 0)

  await widgets.load()
  assert.equal(widgets.list().length, 1)
  assert.equal(widgets.list()[0]?.repo, "acme/widgets")
})

test("the delivery ledger claims a key once across instances", async () => {
  const storage = memoryStorage()
  const first = new DeliveryLedger(storage, "acme/widgets", () => 1_000_000)
  const second = new DeliveryLedger(storage, "acme/widgets", () => 1_000_000)

  assert.equal(await first.claim("push:main:abc"), false)
  assert.equal(await second.claim("push:main:abc"), true)
  assert.equal(await first.claim("push:main:def"), false)
})

test("the delivery ledger forgets stale claims", async () => {
  const storage = memoryStorage()
  const ledger = new DeliveryLedger(storage, "acme/widgets", () => 1_000_000)
  await ledger.claim("push:main:abc")

  const later = new DeliveryLedger(storage, "acme/widgets", () => 1_000_000 + 25 * 60 * 60 * 1000)
  assert.equal(await later.claim("push:main:abc"), false)
})
