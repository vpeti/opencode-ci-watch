import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { errorMessage } from "../log.ts"
import type { RepoRef } from "../types.ts"

const run = promisify(execFile)

export type RepoResult = { ok: true; repo: RepoRef } | { ok: false; message: string }

const NAME = /^[A-Za-z0-9_.-]+$/

function trimGit(name: string): string {
  return name.replace(/\.git$/i, "").replace(/\/+$/, "")
}

export function parseGithubRemote(remote: string, host = "github.com"): RepoRef | null {
  const value = remote.trim()
  if (!value) return null

  let path: string | undefined
  // scp-like: git@github.com:owner/repo.git
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value)
  if (scp && !value.includes("://")) {
    if (scp[1] !== host) return null
    path = scp[2]
  } else {
    try {
      const url = new URL(value)
      if (url.hostname !== host) return null
      path = url.pathname.replace(/^\/+/, "")
    } catch {
      return null
    }
  }

  if (!path) return null
  const parts = trimGit(path).split("/")
  if (parts.length !== 2) return null
  const [owner, name] = parts
  if (!owner || !name || !NAME.test(owner) || !NAME.test(name)) return null
  return { owner, name, slug: `${owner}/${name}` }
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  })
  return stdout.trim()
}

export async function resolveRepo(input: {
  directory: string
  explicit?: string
  host?: string
}): Promise<RepoResult> {
  const host = input.host ?? "github.com"

  if (input.explicit) {
    const parsed = parseGithubRemote(input.explicit, host)
    if (parsed) return { ok: true, repo: parsed }
    const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(input.explicit.trim())
    if (shorthand?.[1] && shorthand[2]) {
      return {
        ok: true,
        repo: { owner: shorthand[1], name: shorthand[2], slug: `${shorthand[1]}/${shorthand[2]}` },
      }
    }
    return { ok: false, message: `configured repo "${input.explicit}" is not a ${host} owner/name pair` }
  }

  let remotes: string[]
  try {
    remotes = (await git(["remote"], input.directory)).split("\n").filter(Boolean)
  } catch (error) {
    return {
      ok: false,
      message: `${input.directory} is not a git working copy (${errorMessage(error)})`,
    }
  }
  if (remotes.length === 0) return { ok: false, message: "the repository has no git remotes" }

  const ordered = [
    ...(remotes.includes("origin") ? ["origin"] : []),
    ...(remotes.includes("upstream") ? ["upstream"] : []),
    ...remotes.filter((remote) => remote !== "origin" && remote !== "upstream"),
  ]

  const found: Array<{ remote: string; repo: RepoRef }> = []
  for (const remote of ordered) {
    try {
      const url = await git(["remote", "get-url", remote], input.directory)
      const repo = parseGithubRemote(url, host)
      if (repo) found.push({ remote, repo })
    } catch {
      // Ignore a single unreadable remote; another one may still resolve.
    }
  }

  if (found.length === 0) {
    return {
      ok: false,
      message: `no ${host} remote found (remotes: ${remotes.join(", ")}). Set "repo" in ${".opencode/ci-watch.json"}.`,
    }
  }

  const distinct = new Set(found.map((entry) => entry.repo.slug))
  if (distinct.size > 1) {
    return {
      ok: false,
      message:
        `remotes point at different repositories (${found.map((entry) => `${entry.remote}=${entry.repo.slug}`).join(", ")}). ` +
        `Set "repo" in .opencode/ci-watch.json to pick one.`,
    }
  }

  return { ok: true, repo: found[0]!.repo }
}

export async function currentGitBranch(directory: string): Promise<string | undefined> {
  try {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], directory)
    return branch === "HEAD" ? undefined : branch
  } catch {
    return undefined
  }
}

export async function sameRepo(left: string, right: string): Promise<boolean> {
  try {
    const a = await git(["rev-parse", "--show-toplevel"], left)
    const b = await git(["rev-parse", "--show-toplevel"], right)
    return a === b
  } catch {
    return false
  }
}
