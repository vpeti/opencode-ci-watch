/**
 * End-to-end check against a real repository:
 *  - starts the plugin (server + `gh webhook forward`)
 *  - subscribes a fake session to a branch
 *  - prints pushes and workflow results as they arrive
 *
 * Run: node --import tsx scripts/e2e.ts [repo] [account] [branch] [seconds] [failures|all]
 * Push to the branch while it is running.
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import plugin from "../src/index.js"
import { createFakeContext } from "./fake-context.js"

const repo = process.argv[2] ?? "OWNER/opencode-ci-watch"
const account = process.argv[3]
const branch = process.argv[4] ?? "main"
const seconds = Number(process.argv[5] ?? "300")
const notify = process.argv[6] ?? "failures"

const directory = join(process.cwd(), ".e2e")
mkdirSync(directory, { recursive: true })

const fake = createFakeContext({
  repo,
  account,
  directory,
  onStatus: (sessionID, text) => {
    console.log(`\n[status ${sessionID}]\n${text ?? "(cleared)"}`)
  },
  onWake: (sessionID, text) => {
    console.log(`\n[wake ${sessionID}]\n${text}`)
  },
})

const setup = (plugin as unknown as { setup: (ctx: unknown) => Promise<() => Promise<void>> }).setup
const cleanup = await setup(fake.context)
console.log("tools:", fake.tools.map((tool) => `ci_${tool.name}`).join(", "))

const result = await fake.call("watch", { branch, include: ["runs", "pushes"], notify }, "ses_e2e")
console.log(result.content)

let closing = false
async function close() {
  if (closing) return
  closing = true
  fake.controller.abort()
  await cleanup()
  process.exit(0)
}

process.on("SIGINT", () => void close())
process.on("SIGTERM", () => void close())

console.log(`listening for ${seconds}s on ${repo}@${branch} — push now`)
await fake.sleep(seconds * 1000)
await close()
