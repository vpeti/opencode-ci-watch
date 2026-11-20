import assert from "node:assert/strict"
import test from "node:test"
import { agentNote, applyAgentTransforms, deniedTools, ruleFor } from "../src/agents.ts"
import type { Config } from "../src/config.ts"

test("read-only mode denies the subscription and wait tools", () => {
  assert.deepEqual(
    deniedTools("read").map((rule) => rule.action),
    ["ci_watch", "ci_unwatch", "ci_wait"],
  )
  assert.deepEqual(deniedTools("all"), [])
  assert.equal(deniedTools("none").length, 5)
  assert.equal(agentNote("none"), undefined)
})

test("per-agent rules merge over the wildcard and false disables", () => {
  const agents = {
    "*": { tools: "read" as const },
    build: { tools: "all" as const, instructions: "push then watch" },
    plan: { tools: "none" as const, instructions: false },
  }
  assert.deepEqual(ruleFor(agents, "build"), { tools: "all", instructions: "push then watch" })
  assert.deepEqual(ruleFor(agents, "plan"), { tools: "none", instructions: false })
  assert.deepEqual(ruleFor(agents, "other"), { tools: "read" })
  assert.equal(ruleFor({}, "build"), undefined)
})

test("applies permissions and instructions only to configured agents", async () => {
  const updates: Array<{ id: string; system?: string; permissions?: unknown[] }> = []
  const editor = {
    list: () => [
      { id: "build", system: "base", permissions: [] },
      { id: "plan", system: undefined, permissions: [] },
    ],
    update: (id: string, update: (agent: { system?: string; permissions?: unknown[] }) => void) => {
      const agent = editor.list().find((entry) => entry.id === id)!
      update(agent)
      updates.push(agent)
    },
  }
  const ctx = { agent: { transform: async (callback: (value: typeof editor) => void) => callback(editor) } }
  const config = { agents: { build: { tools: "read" as const }, plan: { tools: "none" as const, instructions: false } } } as unknown as Config

  await applyAgentTransforms(ctx as never, config)

  const build = updates.find((entry) => entry.id === "build")!
  assert.match(build.system ?? "", /^base\n\nGitHub Actions/)
  assert.equal(build.permissions?.length, 3)

  const plan = updates.find((entry) => entry.id === "plan")!
  assert.equal(plan.system, undefined)
  assert.equal(plan.permissions?.length, 5)
})
