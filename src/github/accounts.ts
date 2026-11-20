import { errorMessage } from "../log.js"
import { Gh } from "./gh.js"

export type AccountResult =
  | { ok: true; account?: string }
  | { ok: false; message: string }

interface CacheEntry {
  at: number
  result: AccountResult
}

const cache = new Map<string, CacheEntry>()
const TTL_MS = 5 * 60 * 1000

interface AuthStatus {
  hosts?: Record<string, Array<{ state?: string; login?: string }>>
}

export async function listAccounts(host: string): Promise<string[]> {
  const gh = new Gh({ host })
  const status = await gh.json<AuthStatus>(["auth", "status", "--json", "hosts"])
  const entries = status.hosts?.[host] ?? []
  return entries
    .filter((entry) => entry.state === "success" && typeof entry.login === "string" && entry.login.length > 0)
    .map((entry) => entry.login as string)
}

async function canPush(host: string, account: string, slug: string): Promise<boolean> {
  try {
    const gh = new Gh({ host, account })
    const value = await gh.text(["api", `repos/${slug}`, "--jq", ".permissions.push"], { timeoutMs: 15_000 })
    return value.trim() === "true"
  } catch {
    return false
  }
}

/**
 * Picks the gh account the plugin should act as.
 * Never calls `gh auth switch`: each candidate is probed with its own token.
 */
export async function resolveAccount(input: {
  host: string
  slug: string
  configured?: string
}): Promise<AccountResult> {
  const key = `${input.host}|${input.slug}|${input.configured ?? ""}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result

  let accounts: string[]
  try {
    accounts = await listAccounts(input.host)
  } catch (error) {
    return { ok: false, message: `cannot read gh accounts: ${errorMessage(error)}` }
  }

  let result: AccountResult
  if (accounts.length === 0) {
    result = { ok: false, message: `no authenticated gh account for ${input.host}; run \`gh auth login\`` }
  } else if (input.configured) {
    result = accounts.includes(input.configured)
      ? { ok: true, account: input.configured }
      : {
          ok: false,
          message: `configured account "${input.configured}" is not logged in (available: ${accounts.join(", ")})`,
        }
  } else if (accounts.length === 1) {
    result = { ok: true, account: accounts[0] }
  } else {
    const pushable: string[] = []
    for (const account of accounts) {
      if (await canPush(input.host, account, input.slug)) pushable.push(account)
    }
    if (pushable.length === 1) result = { ok: true, account: pushable[0] }
    else if (pushable.length === 0)
      result = {
        ok: false,
        message: `none of the gh accounts (${accounts.join(", ")}) can push to ${input.slug}; set "account" explicitly if that is wrong`,
      }
    else
      result = {
        ok: false,
        message: `several gh accounts can push to ${input.slug} (${pushable.join(", ")}); set "account" in the plugin options`,
      }
  }

  cache.set(key, { at: Date.now(), result })
  return result
}
