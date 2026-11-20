import assert from "node:assert/strict"
import test from "node:test"
import { RunCache, SubscriptionStore, type StorageLike } from "../src/store.js"
import { run } from "./helpers.js"

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
  const store = new SubscriptionStore(storage)
  await store.save({
    id: "abc",
    sessionID: "ses_1",
    target: { type: "branch", value: "main" },
    include: ["runs"],
    notify: "failures",
    delivery: "queue",
    createdAt: 1,
    expiresAt: 10,
  })

  const reloaded = new SubscriptionStore(storage)
  await reloaded.load()
  assert.equal(reloaded.list().length, 1)
  assert.equal(reloaded.bySession("ses_1")[0]?.target.value, "main")
})

test("prunes expired subscriptions", async () => {
  const store = new SubscriptionStore(memoryStorage())
  await store.save({
    id: "old",
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
