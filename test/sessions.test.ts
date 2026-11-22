import assert from "node:assert/strict"
import test from "node:test"
import { descendantSessions } from "../src/sessions.ts"

const silent = { info() {}, warn() {}, error() {} }

function lister(tree: Record<string, Array<{ id: string; title?: string }>>) {
  return {
    async list({ parentID }: { parentID: string }) {
      return { data: tree[parentID] ?? [] }
    },
  }
}

test("collects descendants breadth first with titles", async () => {
  const found = await descendantSessions(
    lister({
      ses_root: [{ id: "ses_a", title: "S1: first" }, { id: "ses_b" }],
      ses_a: [{ id: "ses_c", title: "S3: nested" }],
      ses_b: [],
      ses_c: [],
    }),
    "ses_root",
    silent,
  )

  assert.deepEqual(
    found.map((session) => session.id),
    ["ses_a", "ses_b", "ses_c"],
  )
  assert.equal(found[0]?.title, "S1: first")
  assert.equal(found[1]?.title, undefined)
})

test("a session listed twice is reported once", async () => {
  const found = await descendantSessions(
    lister({
      ses_root: [{ id: "ses_a" }, { id: "ses_a", title: "again" }],
      ses_a: [{ id: "ses_root" }],
    }),
    "ses_root",
    silent,
  )

  assert.deepEqual(
    found.map((session) => session.id),
    ["ses_a"],
  )
})

test("depth is bounded", async () => {
  const found = await descendantSessions(
    lister({
      ses_0: [{ id: "ses_1" }],
      ses_1: [{ id: "ses_2" }],
      ses_2: [{ id: "ses_3" }],
      ses_3: [{ id: "ses_4" }],
      ses_4: [{ id: "ses_5" }],
    }),
    "ses_0",
    silent,
  )

  assert.deepEqual(
    found.map((session) => session.id),
    ["ses_1", "ses_2", "ses_3", "ses_4"],
  )
})

test("a failing branch does not hide the others", async () => {
  const warnings: string[] = []
  const found = await descendantSessions(
    {
      async list({ parentID }: { parentID: string }) {
        if (parentID === "ses_root") throw new Error("listing failed")
        return { data: [] }
      },
    },
    "ses_root",
    { ...silent, warn: (message: string) => warnings.push(message) },
  )

  assert.deepEqual(found, [])
  assert.equal(warnings.length, 1)
})
