import assert from "node:assert/strict"
import test from "node:test"
import { matchesPush, matchesRun, targetKey, targetMatchesDelivery } from "../src/match.js"
import type { Subscription } from "../src/store.js"
import { run } from "./helpers.js"

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "s1",
    sessionID: "ses_1",
    target: { type: "branch", value: "main" },
    include: ["runs"],
    notify: "failures",
    delivery: "queue",
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...overrides,
  }
}

test("matches a branch subscription", () => {
  assert.equal(matchesRun(subscription(), run({ branch: "main" })), true)
  assert.equal(matchesRun(subscription(), run({ branch: "feature/x" })), false)
})

test("matches sha targets by prefix, any case", () => {
  const sub = subscription({ target: { type: "sha", value: "A1B2C3D" } })
  assert.equal(matchesRun(sub, run()), true)
  assert.equal(matchesRun(sub, run({ sha: "ffffffffffffffffffffffffffffffffffffffff" })), false)
})

test("matches a specific run id", () => {
  const sub = subscription({ target: { type: "run", value: "1001" } })
  assert.equal(matchesRun(sub, run({ id: 1001 })), true)
  assert.equal(matchesRun(sub, run({ id: 1002 })), false)
})

test("only matches pushes when the subscription asked for them", () => {
  const push = {
    branch: "main",
    before: "0".repeat(40),
    after: run().sha,
    forced: false,
    deleted: false,
    actor: "alice",
    commits: 1,
    headline: "x",
  }
  assert.equal(matchesPush(subscription(), push), false)
  assert.equal(matchesPush(subscription({ include: ["pushes"] }), push), true)
  assert.equal(matchesPush(subscription({ include: ["pushes"] }), { ...push, branch: "other" }), false)
  assert.equal(matchesPush(subscription({ include: ["pushes"], target: { type: "sha", value: "a1b2c3d" } }), push), true)
})

test("target keys are case-insensitive and stable", () => {
  assert.equal(targetKey({ type: "sha", value: "ABC" }), "sha:abc")
  assert.equal(targetMatchesDelivery({ type: "branch", value: "main" }, { run: run() }), true)
  assert.equal(targetMatchesDelivery({ type: "run", value: "1001" }, { run: run() }), true)
  assert.equal(targetMatchesDelivery({ type: "run", value: "1001" }, { run: run({ id: 1002 }) }), false)
})
