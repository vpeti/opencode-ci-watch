import { setTimeout as sleep } from "node:timers/promises"

export interface FakeTool {
  name: string
  description: string
  execute: (input: unknown, context: ToolCallContext) => Promise<{ content: string; metadata?: Record<string, unknown> }>
}

export interface ToolCallContext {
  sessionID: string
  agent: string
  messageID: string
  id: string
  signal: AbortSignal
  progress: (update: Record<string, unknown>) => Promise<void>
}

export interface FakeOptions {
  repo: string
  account?: string
  directory: string
  onStatus?: (sessionID: string, text: string | undefined) => void
  onWake?: (sessionID: string, text: string) => void
  onLog?: (message: string) => void
}

export function createFakeContext(options: FakeOptions) {
  const data = new Map<string, unknown>()
  const tools: FakeTool[] = []
  const skills: Array<{ id: string; name: string }> = []
  const controller = new AbortController()
  const log = options.onLog ?? ((message: string) => console.log(message))

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

  const context = {
    app: { version: "fake" },
    location: { directory: options.directory, project: { id: "fake", directory: options.directory, canonical: "fake" } },
    options: { repo: options.repo, account: options.account },
    storage,
    session: {
      async synthetic(input: { sessionID: string; text: string }) {
        options.onWake?.(input.sessionID, input.text)
        log(`[wake ${input.sessionID}]\n${input.text}`)
      },
      instructions: {
        entry: {
          async put(input: { sessionID: string; value: unknown }) {
            options.onStatus?.(input.sessionID, String(input.value))
          },
          async remove(input: { sessionID: string }) {
            options.onStatus?.(input.sessionID, undefined)
          },
        },
      },
    },
    tool: {
      async transform(callback: (editor: unknown) => void) {
        callback({
          namespace() {},
          add(tool: FakeTool) {
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

  async function call(name: string, input: unknown, sessionID: string, signal?: AbortSignal) {
    const tool = tools.find((entry) => entry.name === name)
    if (!tool) throw new Error(`tool ${name} is not registered`)
    return await tool.execute(input, {
      sessionID,
      agent: "build",
      messageID: "msg_fake",
      id: "call_fake",
      signal: signal ?? new AbortController().signal,
      progress: async () => {},
    })
  }

  return { context, tools, skills, controller, call, sleep }
}
