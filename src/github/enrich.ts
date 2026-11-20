import { toRunInfo } from "../events.ts"
import { trimLog, type TrimmedLog } from "../render.ts"
import type { JobInfo, RepoRef, RunInfo } from "../types.ts"
import { Gh } from "./gh.ts"

const JOB_FIELDS = `{id: .id, name: .name, status: .status, conclusion: .conclusion, url: .html_url, startedAt: .started_at, completedAt: .completed_at, steps: [.steps[]? | {name: .name, conclusion: .conclusion}]}`

interface JobPayload {
  id?: number
  name?: string
  status?: string
  conclusion?: string | null
  url?: string
  startedAt?: string | null
  completedAt?: string | null
  steps?: Array<{ name?: string; conclusion?: string | null }>
}

/** jq yields null for a timestamp the job has not reached; the RPC schema only accepts strings. */
function time(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

export class Enricher {
  private readonly gh: Gh
  private readonly repo: RepoRef

  constructor(gh: Gh, repo: RepoRef) {
    this.gh = gh
    this.repo = repo
  }

  async jobs(runId: number, signal?: AbortSignal): Promise<JobInfo[]> {
    const data = await this.gh.json<{ jobs?: JobPayload[] }>(
      [
        "api",
        `repos/${this.repo.slug}/actions/runs/${runId}/jobs?per_page=100`,
        "--jq",
        `{jobs: [.jobs[] | ${JOB_FIELDS}]}`,
      ],
      { signal },
    )
    return (data.jobs ?? []).map((job) => {
      const conclusion = job.conclusion ?? null
      return {
        id: job.id ?? 0,
        name: job.name ?? "job",
        status: conclusion !== null ? "completed" : (job.status ?? "unknown"),
        conclusion,
        url: job.url ?? "",
        steps: (job.steps ?? []).map((step) => ({ name: step.name ?? "step", conclusion: step.conclusion ?? null })),
        startedAt: time(job.startedAt),
        completedAt: time(job.completedAt),
      }
    })
  }

  async failedLog(runId: number, jobId: number | undefined, maxChars: number, signal?: AbortSignal): Promise<TrimmedLog> {
    const args = ["run", "view", String(runId), "--log-failed", "-R", this.repo.slug]
    if (jobId !== undefined) args.push("--job", String(jobId))
    const raw = await this.gh.text(args, { timeoutMs: 120_000, signal })
    return trimLog(raw, maxChars)
  }

  async run(runId: number, signal?: AbortSignal): Promise<RunInfo | undefined> {
    const data = await this.gh.json<unknown>(["api", `repos/${this.repo.slug}/actions/runs/${runId}`], { signal })
    return toRunInfo(data)
  }

  async recentRuns(branch: string, limit = 5, signal?: AbortSignal): Promise<RunInfo[]> {
    const query = `repos/${this.repo.slug}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${limit}`
    const data = await this.gh.json<{ workflow_runs?: unknown[] }>(
      ["api", query, "--jq", "{workflow_runs: [.workflow_runs[]]}"],
      { signal },
    )
    return (data.workflow_runs ?? [])
      .map((entry) => toRunInfo(entry))
      .filter((entry): entry is RunInfo => entry !== undefined)
  }

  /**
   * The runs for one commit. GitHub's `head_sha` filter only matches a full sha —
   * an abbreviation silently returns nothing — so resolve it first and also filter
   * client-side in case the API ignores the parameter altogether.
   */
  async runsForSha(sha: string, limit = 5, signal?: AbortSignal): Promise<RunInfo[]> {
    const full = await this.fullSha(sha, signal)
    const query = `repos/${this.repo.slug}/actions/runs?head_sha=${encodeURIComponent(full)}&per_page=20`
    const data = await this.gh.json<{ workflow_runs?: unknown[] }>(
      ["api", query, "--jq", "{workflow_runs: [.workflow_runs[]]}"],
      { signal },
    )
    const wanted = full.toLowerCase()
    return (data.workflow_runs ?? [])
      .map((entry) => toRunInfo(entry))
      .filter((entry): entry is RunInfo => entry !== undefined && entry.sha.toLowerCase().startsWith(wanted))
      .slice(0, limit)
  }

  /** Expand an abbreviated commit sha; on failure keep the input and let the caller filter. */
  private async fullSha(sha: string, signal?: AbortSignal): Promise<string> {
    if (sha.length >= 40) return sha
    try {
      const data = await this.gh.json<{ sha?: string }>(
        ["api", `repos/${this.repo.slug}/commits/${encodeURIComponent(sha)}`, "--jq", "{sha: .sha}"],
        { signal },
      )
      return typeof data.sha === "string" && data.sha.length >= 40 ? data.sha : sha
    } catch {
      return sha
    }
  }
}
