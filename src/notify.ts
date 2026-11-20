import type { DeliveryMode } from "./config.ts"
import { errorMessage } from "./log.ts"
import type { Logger } from "./types.ts"

export interface SessionApiLike {
  synthetic(input: {
    sessionID: string
    text: string
    description?: string
    delivery?: DeliveryMode
    metadata?: Record<string, unknown>
    resume?: boolean
  }): Promise<unknown>
  instructions: {
    entry: {
      put(input: { sessionID: string; key: string; value: unknown }): Promise<void>
      remove(input: { sessionID: string; key: string }): Promise<void>
    }
  }
}

export const STATUS_KEY = "ci"

export class Notifier {
  private readonly session: SessionApiLike
  private readonly log: Logger
  private readonly warned = new Set<string>()

  constructor(session: SessionApiLike, log: Logger) {
    this.session = session
    this.log = log
  }

  /** Rewrites the `<context key="ci">` block. Never queues a turn. */
  async setStatus(sessionID: string, text: string | undefined): Promise<void> {
    try {
      if (text === undefined) {
        await this.session.instructions.entry.remove({ sessionID, key: STATUS_KEY })
        return
      }
      await this.session.instructions.entry.put({ sessionID, key: STATUS_KEY, value: text })
    } catch (error) {
      this.warnOnce(sessionID, `cannot update the ci status entry: ${errorMessage(error)}`)
    }
  }

  /** Injects a synthetic message, waking an idle session. */
  async wake(sessionID: string, text: string, delivery: DeliveryMode): Promise<boolean> {
    try {
      await this.session.synthetic({
        sessionID,
        text,
        description: "GitHub Actions",
        delivery,
        metadata: { source: "opencode-ci-watch" },
      })
      return true
    } catch (error) {
      this.warnOnce(sessionID, `cannot deliver a CI notification: ${errorMessage(error)}`)
      return false
    }
  }

  private warnOnce(sessionID: string, message: string): void {
    if (this.warned.has(sessionID)) return
    this.warned.add(sessionID)
    this.log.warn(message, { session: sessionID })
  }
}
