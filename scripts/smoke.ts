/**
 * Loads the plugin against a fake OpenCode context to check wiring without a full server.
 * Run with: node --import tsx scripts/smoke.ts [repo] [account]
 */
import plugin from "../src/index.js"

const repo = process.argv[2] ?? "vpeti/opencode-ci-watch"
const account = process.argv[3]

const data = new Map<string, unknown>()
const storage = {
  async get(key: string) {
    return data.get(key)
  },
  async set(key: string, value: unknown) {
    data.set(key, value)
  },
  async remove(key: string) {
    data.delete(key)
  },
  async scan() {
    return { entries: [], next: undefined }
  },
}

const tools: Array<{ name: string; description: string }> = []
const skills: Array<{ id: string; name: string }> = []
const statuses: Array<string | undefined> = []
const controller = new AbortController()

const context = {
  app: { version: "smoke" },
  location: {
    directory: new URL("..", import.meta.url).pathname,
    project: { id: "smoke", directory: new URL("..", import.meta.url).pathname, canonical: "smoke" },
  },
  options: { repo, account },
  storage,
  session: {
    async synthetic() {},
    instructions: {
      entry: {
        async put(input: { value: unknown }) {
          statuses.push(String(input.value))
        },
        async remove() {
          statuses.push(undefined)
        },
      },
    },
  },
  tool: {
    async transform(callback: (editor: unknown) => void) {
      callback({
        namespace() {},
        add(tool: { name: string; description: string }) {
          tools.push(tool)
        },
      })
      return { dispose: async () => {} }
    },
    async hook() {
      return { dispose: async () => {} }
    },
  },
  skill: {
    async transform(callback: (editor: unknown) => void) {
      callback({
        add(skill: { id: string; name: string }) {
          skills.push(skill)
        },
      })
      return { dispose: async () => {} }
    },
  },
  event: {
    subscribe() {
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }))
        },
      }
    },
  },
}

const setup = (plugin as unknown as { setup: (ctx: unknown) => Promise<() => Promise<void>> }).setup
const cleanup = await setup(context)
console.log("tools:", tools.map((tool) => `ci_${tool.name}`).join(", "))
console.log("skills:", skills.map((skill) => skill.id).join(", "))
console.log("status entries written:", statuses.length)
controller.abort()
await cleanup()
console.log("cleaned up")
