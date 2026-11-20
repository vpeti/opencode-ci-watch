import assert from "node:assert/strict"
import test from "node:test"
import { Gh } from "../src/github/gh.ts"

test("surfaces the spawn error when stderr is empty", async () => {
  const gh = new Gh({ host: "github.com", cwd: "/nonexistent/opencode-ci-watch" })
  await assert.rejects(
    gh.exec(["api", "repos/acme/widgets"]),
    (error: Error) => /ENOENT|no such file|spawn/i.test(error.message),
  )
})
