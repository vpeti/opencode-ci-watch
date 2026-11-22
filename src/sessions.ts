import { errorMessage } from "./log.ts"
import type { Logger } from "./types.ts"

export interface SessionSummary {
  readonly id: string
  readonly title?: string
}

interface ListedSession {
  readonly id: string
  readonly title?: string
}

export interface SessionListerLike {
  list(input: {
    parentID: string
    limit?: number
  }): Promise<{ readonly data?: readonly ListedSession[] } | undefined | null>
}

const PAGE = 100
const MAX_DEPTH = 4

/**
 * Every session below `sessionID`, breadth first.
 *
 * Subagents run in child sessions and watch their own targets, so a dashboard
 * that only reads the viewed session would hide the work it dispatched. The
 * depth bound keeps a pathological chain from turning the dashboard into a
 * full-table walk, and a failure to list children degrades to the session's own
 * subscriptions instead of failing the RPC.
 */
export async function descendantSessions(
  sessions: SessionListerLike,
  sessionID: string,
  log: Logger,
): Promise<SessionSummary[]> {
  const seen = new Set<string>([sessionID])
  const found: SessionSummary[] = []
  let frontier: string[] = [sessionID]

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = []
    for (const parentID of frontier) {
      const page = await sessions.list({ parentID, limit: PAGE }).catch((error: unknown) => {
        log.warn("cannot list child sessions", { sessionID: parentID, error: errorMessage(error) })
        return undefined
      })
      for (const session of page?.data ?? []) {
        if (seen.has(session.id)) continue
        seen.add(session.id)
        found.push({ id: session.id, ...(session.title ? { title: session.title } : {}) })
        next.push(session.id)
      }
    }
    frontier = next
  }

  return found
}
