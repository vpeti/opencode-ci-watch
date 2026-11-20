import type { Logger } from "../types.js"
import type { Gh } from "./gh.js"

interface HookPayload {
  id?: number
  name?: string
}

const CLI_HOOK = "cli"

/**
 * Tracks the dev webhook that `gh webhook forward` creates, so it can be deleted when the
 * forwarder stops. GitHub leaves the hook behind otherwise.
 */
export class DevHookTracker {
  private readonly gh: Gh
  private readonly slug: string
  private readonly log: Logger
  private before = new Set<number>()
  private owned = new Set<number>()

  constructor(gh: Gh, slug: string, log: Logger) {
    this.gh = gh
    this.slug = slug
    this.log = log
  }

  private async list(): Promise<number[]> {
    const hooks = await this.gh.json<HookPayload[]>(["api", `repos/${this.slug}/hooks`, "--jq", "[.[] | {id, name}]"])
    return hooks.filter((hook) => hook.name === CLI_HOOK && typeof hook.id === "number").map((hook) => hook.id as number)
  }

  /** Snapshot before the forwarder starts, so afterwards only the new hook is adopted. */
  async snapshot(): Promise<void> {
    try {
      this.before = new Set(await this.list())
    } catch (error) {
      this.log.warn("cannot list repository hooks", { error: String(error) })
      this.before = new Set()
    }
  }

  /** Adopt hooks that appeared since {@link snapshot}. */
  async adopt(): Promise<void> {
    try {
      for (const id of await this.list()) {
        if (!this.before.has(id)) this.owned.add(id)
      }
    } catch (error) {
      this.log.warn("cannot adopt the dev webhook", { error: String(error) })
    }
  }

  async removeOwned(): Promise<void> {
    for (const id of this.owned) {
      try {
        await this.gh.exec(["api", "-X", "DELETE", `repos/${this.slug}/hooks/${id}`])
        this.log.info("removed dev webhook", { id })
      } catch (error) {
        this.log.warn("cannot remove the dev webhook", { id, error: String(error) })
      }
    }
    this.owned.clear()
  }
}
