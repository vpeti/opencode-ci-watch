import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import test from "node:test"
import { startWebhookServer, verifySignature } from "../src/http.js"
import type { Logger } from "../src/types.js"

const silent: Logger = { info() {}, warn() {}, error() {} }

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

test("verifies a matching signature and rejects a wrong one", () => {
  const body = Buffer.from('{"ok":true}')
  assert.equal(verifySignature("s3cret", body, sign("s3cret", body.toString())), true)
  assert.equal(verifySignature("s3cret", body, sign("other", body.toString())), false)
  assert.equal(verifySignature("s3cret", body, undefined), false)
  assert.equal(verifySignature("s3cret", body, "sha256=short"), false)
})

test("accepts a signed delivery once and dedupes the delivery id", async () => {
  const secret = "top-secret"
  const seen: Array<{ event: string; id: string }> = []
  const server = await startWebhookServer({
    secret,
    allowedEvents: ["push"],
    log: silent,
    onDelivery: (event, id) => seen.push({ event, id }),
  })

  const body = JSON.stringify({ ref: "refs/heads/main" })
  const send = (id: string, signature: string) =>
    fetch(`http://127.0.0.1:${server.port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": id, "x-hub-signature-256": signature },
      body,
    })

  const first = await send("delivery-1", sign(secret, body))
  assert.equal(first.status, 202)
  const duplicate = await send("delivery-1", sign(secret, body))
  assert.equal(duplicate.status, 202)
  const rejected = await send("delivery-2", "sha256=deadbeef")
  assert.equal(rejected.status, 401)

  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(seen, [{ event: "push", id: "delivery-1" }])

  const wrongPath = await fetch(`http://127.0.0.1:${server.port}/other`, { method: "POST" })
  assert.equal(wrongPath.status, 404)
  const wrongMethod = await fetch(`http://127.0.0.1:${server.port}/hook`, { method: "GET" })
  assert.equal(wrongMethod.status, 405)

  await server.close()
})

test("ignores event types it did not ask for", async () => {
  const secret = "s"
  const seen: string[] = []
  const server = await startWebhookServer({
    secret,
    allowedEvents: ["push"],
    log: silent,
    onDelivery: (event) => seen.push(event),
  })
  const body = "{}"
  const response = await fetch(`http://127.0.0.1:${server.port}/hook`, {
    method: "POST",
    headers: { "x-github-event": "issues", "x-github-delivery": "d3", "x-hub-signature-256": sign(secret, body) },
    body,
  })
  assert.equal(response.status, 202)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(seen, [])
  await server.close()
})
