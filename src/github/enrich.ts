import { toRunInfo } from "../events.ts"
import { trimLog, type TrimmedLog } from "../render.ts"
import type { JobInfo, RepoRef, RunInfo } from "../types.ts"
import { Gh } from "./gh.ts"

const JOB_FIELDS = `{id: .id, name: .name, status: .status, conclusion: .conclusion, url: .html_url, steps: [.steps[]? | {name: .name, conclusion: .conclusion}]}`

interface JobPayload {
  id?: number
  name?: string
  status?: string
  conclusion?: string | null
  url?: string
  steps?: Array<{ name?: string; conclusion?: string | null }>
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
    return (data.jobs ?? []).map((job) => ({
      id: job.id ?? 0,
      name: job.name ?? "job",
      status: job.status ?? "unknown",
      conclusion: job.conclusion ?? null,
      url: job.url ?? "",
      steps: (job.steps ?? []).map((step) => ({ name: step.name ?? "step", conclusion: step.conclusion ?? null })),
    }))
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

  async runsForSha(sha: string, limit = 5, signal?: AbortSignal): Promise<RunInfo[]> {
    // `head_sha` is not accepted by every API version; filter client-side so this stays correct either way.
    const query = `repos/${this.repo.slug}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`
    const data = await this.gh.json<{ workflow_runs?: unknown[] }>(
      ["api", query, "--jq", "{workflow_runs: [.workflow_runs[]]}"],
      { signal },
    )
    const wanted = sha.toLowerCase()
    return (data.workflow_runs ?? [])
      .map((entry) => toRunInfo(entry))
      .filter((entry): entry is RunInfo => entry !== undefined && entry.sha.toLowerCase().startsWith(wanted))
      .slice(0, limit)
  }
}
