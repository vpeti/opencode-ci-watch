/**
 * Loads the plugin against a fake OpenCode context to check wiring without a full server.
 * Run with: node --import tsx scripts/smoke.ts [repo] [account]
 */
import { join } from "node:path"
import plugin from "../src/index.js"
import { createFakeContext } from "./fake-context.js"

const repo = process.argv[2] ?? "vpeti/opencode-ci-watch"
const account = process.argv[3]

const fake = createFakeContext({ repo, account, directory: join(process.cwd(), ".smoke") })
const setup = (plugin as unknown as { setup: (ctx: unknown) => Promise<() => Promise<void>> }).setup

try {
  const cleanup = await setup(fake.context)
  console.log("tools:", fake.tools.map((tool) => `ci_${tool.name}`).join(", "))
  console.log("skills:", fake.skills.map((skill) => skill.id).join(", "))
  fake.controller.abort()
  await cleanup()
  console.log("cleaned up")
} catch (error) {
  console.error("smoke failed:", error)
  process.exit(1)
}
