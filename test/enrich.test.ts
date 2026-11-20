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
