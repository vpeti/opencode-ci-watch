/**
 * Prints `ci_status` for a branch, commit or run against the real GitHub API.
 * Run: node --import tsx scripts/inspect.ts [repo] [account] [branch]
 */
import { join } from "node:path"
import plugin from "../src/index.js"
import { createFakeContext } from "./fake-context.js"

const repo = process.argv[2] ?? "vpeti/opencode-ci-watch"
const account = process.argv[3]
const branch = process.argv[4] ?? "main"

const fake = createFakeContext({ repo, account, directory: join(process.cwd(), ".smoke") })
const setup = (plugin as unknown as { setup: (ctx: unknown) => Promise<() => Promise<void>> }).setup
const cleanup = await setup(fake.context)
const result = await fake.call("status", { branch, recent: 2, include: ["jobs", "logs"] }, "ses_inspect")
console.log(result.content)
console.log(JSON.stringify(result.metadata, null, 2))
fake.controller.abort()
await cleanup()
