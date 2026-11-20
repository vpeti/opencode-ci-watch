import type { Delivery, PushInfo, RepoRef, RunInfo } from "./types.ts"

function rec(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function bool(value: unknown): boolean {
  return value === true
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function repoFromPayload(payload: unknown): RepoRef | undefined {
  const repository = rec(rec(payload)?.repository)
  const fullName = str(repository?.full_name)
  if (!fullName) return undefined
  const [owner, name] = fullName.split("/")
  if (!owner || !name) return undefined
  return { owner, name, slug: `${owner}/${name}` }
}

function pushInfo(payload: Record<string, unknown>): PushInfo | undefined {
  const ref = str(payload.ref)
  if (!ref || !ref.startsWith("refs/heads/")) return undefined
  const after = str(payload.after) ?? ""
  const deleted = bool(payload.deleted) || /^0+$/.test(after)
  const head = rec(payload.head_commit)
  const headline = (str(head?.message) ?? "").split("\n")[0] ?? ""
  const pusher = rec(payload.pusher)
  const sender = rec(payload.sender)
  return {
    branch: ref.slice("refs/heads/".length),
    before: str(payload.before) ?? "",
    after,
    forced: bool(payload.forced),
    deleted,
    actor: str(pusher?.name) ?? str(sender?.login) ?? "unknown",
    commits: list(payload.commits).length,
    headline,
  }
}

/** Normalizes an API or webhook workflow run object. */
export function toRunInfo(value: unknown): RunInfo | undefined {
  const run = rec(value)
  if (!run) return undefined
  const id = num(run.id)
  if (id === undefined) return undefined
  const pullRequests = list(run.pull_requests)
    .map((entry) => num(rec(entry)?.number))
    .filter((value): value is number => value !== undefined)
  return {
    id,
    name: str(run.name) ?? str(run.workflow_name) ?? "workflow",
    branch: str(run.head_branch) ?? "",
    sha: str(run.head_sha) ?? "",
    event: str(run.event) ?? "unknown",
    status: str(run.status) ?? "unknown",
    conclusion: str(run.conclusion) ?? null,
    attempt: num(run.run_attempt) ?? 1,
    url: str(run.html_url) ?? "",
    pullRequests,
    createdAt: str(run.created_at),
    updatedAt: str(run.updated_at),
  }
}

/** Converts a GitHub webhook payload into the small shape the plugin cares about. */
export function normalizeDelivery(event: string, payload: unknown): Delivery | null {
  const repo = repoFromPayload(payload)
  const body = rec(payload)
  if (!repo || !body) return null

  if (event === "push") {
    const push = pushInfo(body)
    return push ? { kind: "push", repo, push } : null
  }

  if (event === "workflow_run") {
    const run = toRunInfo(body.workflow_run)
    return run ? { kind: "workflow_run", repo, run } : null
  }

  return null
}

export function isTerminal(run: RunInfo): boolean {
  return run.status === "completed" || run.conclusion !== null
}

export function isFailure(run: RunInfo): boolean {
  return run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "action_required"
}

export function isSuccess(run: RunInfo): boolean {
  return run.conclusion === "success"
}
