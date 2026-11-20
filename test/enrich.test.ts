import assert from "node:assert/strict"
import test from "node:test"
import { Enricher } from "../src/github/enrich.ts"

test("the enricher omits job timestamps that gh reports as null", async () => {
  const gh = {
    async json() {
      return {
        jobs: [
          {
            id: 1,
            name: "test",
            status: "completed",
            conclusion: "success",
            url: "https://github.com/acme/widgets/actions/runs/1/job/1",
            startedAt: "2026-11-20T10:00:05Z",
            completedAt: null,
            steps: [],
          },
          {
            id: 2,
            name: "lint",
            status: "queued",
            conclusion: null,
            url: "https://github.com/acme/widgets/actions/runs/1/job/2",
            startedAt: null,
            completedAt: null,
            steps: [],
          },
        ],
      }
    },
  }
  const enricher = new Enricher(gh as never, { owner: "acme", name: "widgets", slug: "acme/widgets" })

  const jobs = await enricher.jobs(1)
  assert.equal(jobs[0]?.startedAt, "2026-11-20T10:00:05Z")
  assert.equal(jobs[0]?.completedAt, undefined)
  assert.equal(jobs[1]?.startedAt, undefined)
  assert.equal(jobs[1]?.completedAt, undefined)
})

test("the enricher resolves an abbreviated sha before filtering runs", async () => {
  const calls: string[] = []
  const full = "1f1a873bb6eae2e4fc6c75377849e40aa9dc5fa6"
  const gh = {
    async json(args: string[]) {
      calls.push(args[1] ?? "")
      if ((args[1] ?? "").includes("/commits/")) return { sha: full }
      return {
        workflow_runs: [
          { id: 1, name: "CI", head_branch: "main", head_sha: full, event: "push", status: "queued", conclusion: null, run_attempt: 1, html_url: "u", pull_requests: [] },
          { id: 2, name: "CI", head_branch: "main", head_sha: "ffffffffffffffffffffffffffffffffffffffff", event: "push", status: "queued", conclusion: null, run_attempt: 1, html_url: "u", pull_requests: [] },
        ],
      }
    },
  }
  const enricher = new Enricher(gh as never, { owner: "acme", name: "widgets", slug: "acme/widgets" })

  const runs = await enricher.runsForSha("1f1a873")
  assert.deepEqual(runs.map((entry) => entry.id), [1])
  assert.ok(calls[0]?.includes(`/commits/1f1a873`))
  assert.ok(calls[1]?.includes(`head_sha=${full}`))
})

test("the enricher skips the commit lookup for a full sha", async () => {
  const calls: string[] = []
  const full = "1f1a873bb6eae2e4fc6c75377849e40aa9dc5fa6"
  const gh = {
    async json(args: string[]) {
      calls.push(args[1] ?? "")
      return { workflow_runs: [] }
    },
  }
  const enricher = new Enricher(gh as never, { owner: "acme", name: "widgets", slug: "acme/widgets" })

  await enricher.runsForSha(full)
  assert.equal(calls.length, 1)
  assert.ok(calls[0]?.includes(`head_sha=${full}`))
})
