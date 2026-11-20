import assert from "node:assert/strict"
import test from "node:test"
import { formatDuration, renderFailure, renderPush, renderRunLine, renderSuccess, trimLog } from "../src/render.ts"
import { job, run } from "./helpers.ts"

test("formats durations", () => {
  assert.equal(formatDuration(9_000), "9s")
  assert.equal(formatDuration(134_000), "2m14s")
  assert.equal(formatDuration(3_900_000), "1h5m")
})

test("renders a success line with the run id and duration", () => {
  const line = renderSuccess(run())
  assert.equal(line, "✅ ci main · r1001 · success · 2m14s")
})

test("renders a failure with the failing job, step and excerpt", () => {
  const text = renderFailure(run({ conclusion: "failure" }), [job(), job({ id: 5002, name: "lint", conclusion: "success" })], {
    text: "error[E0308]: mismatched types",
    job: "test",
    step: "cargo test",
  })
  assert.match(text, /^❌ ci main · r1001 · 1\/2 jobs failed \(test\)/)
  assert.match(text, /✗ test · step "cargo test"/)
  assert.match(text, /error\[E0308\]: mismatched types/)
  assert.match(text, /gh run view 1001 --log-failed/)
})

test("renders a push with sha, count, author and subject", () => {
  const text = renderPush({
    branch: "main",
    before: "0".repeat(40),
    after: "b1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    forced: false,
    deleted: false,
    actor: "alice",
    commits: 3,
    headline: "fix: retry backoff",
  })
  assert.equal(text, '⤴️ main · b1b2c3d · 3 commits · alice · "fix: retry backoff"')
})

test("renders a running run with an hourglass", () => {
  assert.match(renderRunLine(run({ status: "in_progress", conclusion: null })), /^⏳/)
})

test("trims logs around the first error", () => {
  const raw = [
    "test\tcheckout\t2026-11-20T10:00:00.0000000Z Preparing",
    "test\tcargo test\t2026-11-20T10:00:01.0000000Z running 12 tests",
    "test\tcargo test\t2026-11-20T10:00:02.0000000Z error[E0308]: mismatched types",
    "test\tcargo test\t2026-11-20T10:00:02.1000000Z  --> src/db.rs:88",
    "test\tcargo test\t2026-11-20T10:00:02.2000000Z ##[error]Process completed with exit code 101.",
    "test\treport\t2026-11-20T10:00:03.0000000Z done",
  ].join("\n")
  const trimmed = trimLog(raw, 500)
  assert.equal(trimmed.job, "test")
  assert.equal(trimmed.step, "cargo test")
  assert.ok(trimmed.text.startsWith("running 12 tests"))
  assert.ok(trimmed.text.includes("##[error]"))
  assert.ok(!trimmed.text.includes("Preparing"))
})

test("falls back to the tail when no error marker exists", () => {
  const raw = Array.from({ length: 100 }, (_, index) => `job\tstep\t2026-11-20T10:00:00Z line ${index}`).join("\n")
  const trimmed = trimLog(raw, 200)
  assert.ok(trimmed.text.includes("line 99"))
  assert.ok(trimmed.text.length <= 200)
  assert.ok(trimmed.text.startsWith("… (truncated)"))
})

test("strips caret-escaped colour codes and runner noise", () => {
  const raw = [
    "test\tstep\t2026-11-20T10:00:00Z ^[[36;1mecho hi^[[0m",
    "test\tstep\t2026-11-20T10:00:01Z shell: /usr/bin/bash -e {0}",
    "test\tstep\t2026-11-20T10:00:02Z ##[endgroup]",
    "test\tstep\t2026-11-20T10:00:03Z error: boom",
  ].join("\n")
  const trimmed = trimLog(raw, 500)
  assert.ok(!trimmed.text.includes("^[["))
  assert.ok(!trimmed.text.includes("shell:"))
  assert.ok(!trimmed.text.includes("endgroup"))
  assert.ok(trimmed.text.includes("error: boom"))
})
