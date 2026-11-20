import { spawn, type ChildProcess } from "node:child_process"
import { redact } from "./log.js"
import type { Logger } from "./types.js"

export type ForwarderState = "stopped" | "starting" | "running" | "restarting" | "forbidden" | "error"

export interface ForwarderOptions {
  readonly repo: string
  readonly url: string
  readonly secret: string
  readonly events: readonly string[]
  readonly token?: string
  readonly restartMax: number
  readonly log: Logger
  /** Runs before the child is spawned, for example to snapshot repository hooks. */
  readonly beforeStart?: () => Promise<void> | void
  /** Runs once the websocket is attached, for example to adopt the dev webhook it created. */
  readonly onAttached?: () => Promise<void> | void
}

const BACKOFF_MS = [1_000, 5_000, 20_000, 60_000]

export class Forwarder {
  private readonly options: ForwarderOptions
  private child: ChildProcess | undefined
  private retryTimer: NodeJS.Timeout | undefined
  private killTimer: NodeJS.Timeout | undefined
  private stopping = false
  private attempts = 0
  private current: ForwarderState = "stopped"
  private failure: string | undefined

  constructor(options: ForwarderOptions) {
    this.options = options
  }

  get state(): ForwarderState {
    return this.current
  }

  get lastError(): string | undefined {
    return this.failure
  }

  async start(): Promise<void> {
    if (this.child || this.stopping) return
    this.attempts = 0
    await this.options.beforeStart?.()
    this.spawnChild()
  }

  private spawnChild(): void {
    this.current = "starting"
    const env: NodeJS.ProcessEnv = { ...process.env, GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" }
    if (this.options.token) env.GH_TOKEN = this.options.token

    const args = [
      "webhook",
      "forward",
      "--repo",
      this.options.repo,
      "--events",
      this.options.events.join(","),
      "--url",
      this.options.url,
      "--secret",
      this.options.secret,
    ]

    let child: ChildProcess
    try {
      child = spawn("gh", args, { env, stdio: ["ignore", "ignore", "pipe"] })
    } catch (error) {
      this.fail(`cannot start gh: ${String(error)}`)
      return
    }
    this.child = child

    let buffer = ""
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf("\n")
      while (index !== -1) {
        const line = redact(buffer.slice(0, index).trim())
        buffer = buffer.slice(index + 1)
        if (line) this.handleLine(line)
        index = buffer.indexOf("\n")
      }
    })

    child.on("error", (error) => {
      this.child = undefined
      this.fail(`cannot start gh webhook forward: ${error.message}`)
    })

    child.on("exit", (code, signal) => {
      this.child = undefined
      if (this.stopping) {
        this.current = "stopped"
        return
      }
      if (this.current === "forbidden") {
        this.current = "stopped"
        return
      }
      if (this.current === "error" && code === null && signal === null) return
      this.failure = `gh webhook forward exited (${signal ? `signal ${signal}` : `code ${code}`})`
      this.scheduleRestart()
    })
  }

  private handleLine(line: string): void {
    if (line.includes("Forwarding Webhook events")) {
      this.attempts = 0
      this.failure = undefined
      this.current = "running"
      this.options.log.info("webhook forwarder attached", { repo: this.options.repo })
      void Promise.resolve(this.options.onAttached?.()).catch((error) => {
        this.options.log.warn("attached hook callback failed", { error: String(error) })
      })
      return
    }
    if (line.includes("you do not have access to this feature")) {
      this.failure = "this gh account cannot create dev webhooks on the repository (403)"
      this.current = "forbidden"
      this.options.log.error("webhook forwarder is not permitted", { repo: this.options.repo })
      return
    }
    if (line.includes("warning:")) {
      this.options.log.warn(line)
      return
    }
    if (line.toLowerCase().includes("error")) {
      this.options.log.warn(line)
    }
  }

  private scheduleRestart(): void {
    if (this.attempts >= this.options.restartMax) {
      this.current = "error"
      this.options.log.error("webhook forwarder stopped after too many restarts", {
        repo: this.options.repo,
        attempts: this.attempts,
      })
      return
    }
    const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)] ?? 60_000
    this.attempts += 1
    this.current = "restarting"
    this.options.log.warn("restarting webhook forwarder", { delayMs: delay, attempt: this.attempts })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (!this.stopping) this.spawnChild()
    }, delay)
    this.retryTimer.unref()
  }

  private fail(message: string): void {
    this.failure = message
    this.current = "error"
    this.options.log.error(message, { repo: this.options.repo })
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    const child = this.child
    if (!child) {
      this.current = "stopped"
      return
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        if (this.killTimer) {
          clearTimeout(this.killTimer)
          this.killTimer = undefined
        }
        resolve()
      }
      child.once("exit", done)
      child.kill("SIGTERM")
      this.killTimer = setTimeout(() => {
        child.kill("SIGKILL")
        done()
      }, 3_000)
      this.killTimer.unref()
    })
    this.child = undefined
    this.current = "stopped"
  }
}
