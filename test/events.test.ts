import assert from "node:assert/strict"
import test from "node:test"
import { isFailure, isSuccess, isTerminal, normalizeDelivery } from "../src/events.ts"
import { pushPayload, workflowRunPayload } from "./helpers.ts"

test("normalizes a workflow_run event", () => {
  const delivery = normalizeDelivery("workflow_run", workflowRunPayload())
  assert.ok(delivery)
  assert.equal(delivery.kind, "workflow_run")
  if (delivery.kind !== "workflow_run") return
  assert.equal(delivery.repo.slug, "acme/widgets")
  assert.equal(delivery.run.id, 1001)
  assert.equal(delivery.run.branch, "main")
  assert.equal(delivery.run.conclusion, "failure")
  assert.equal(delivery.run.attempt, 1)
  assert.equal(isTerminal(delivery.run), true)
  assert.equal(isFailure(delivery.run), true)
  assert.equal(isSuccess(delivery.run), false)
})

test("normalizes a push event", () => {
  const delivery = normalizeDelivery("push", pushPayload())
  assert.ok(delivery)
  assert.equal(delivery.kind, "push")
  if (delivery.kind !== "push") return
  assert.equal(delivery.push.branch, "main")
  assert.equal(delivery.push.commits, 3)
  assert.equal(delivery.push.headline, "fix: retry backoff")
  assert.equal(delivery.push.actor, "alice")
})

test("marks a deleted branch push", () => {
  const delivery = normalizeDelivery(
    "push",
    pushPayload({ after: "0000000000000000000000000000000000000000", deleted: true, commits: [] }),
  )
  assert.ok(delivery && delivery.kind === "push")
  assert.equal(delivery.push.deleted, true)
})

test("ignores tag pushes and unrelated events", () => {
  assert.equal(normalizeDelivery("push", pushPayload({ ref: "refs/tags/v1.0.0" })), null)
  assert.equal(normalizeDelivery("ping", pushPayload()), null)
  assert.equal(normalizeDelivery("issues", { repository: { full_name: "acme/widgets" } }), null)
})

test("rejects payloads without a repository or run id", () => {
  assert.equal(normalizeDelivery("push", { ref: "refs/heads/main" }), null)
  assert.equal(normalizeDelivery("workflow_run", { repository: { full_name: "acme/widgets" }, workflow_run: {} }), null)
})
