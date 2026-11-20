import type { JobInfo, RunInfo } from "../src/types.ts"

export function run(overrides: Partial<RunInfo> = {}): RunInfo {
  return {
    id: 1001,
    name: "ci",
    branch: "main",
    sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    event: "push",
    status: "completed",
    conclusion: "success",
    attempt: 1,
    url: "https://github.com/acme/widgets/actions/runs/1001",
    pullRequests: [],
    createdAt: "2026-11-20T10:00:00Z",
    updatedAt: "2026-11-20T10:02:14Z",
    ...overrides,
  }
}

export function job(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: 5001,
    name: "test",
    status: "completed",
    conclusion: "failure",
    url: "https://github.com/acme/widgets/actions/runs/1001/job/5001",
    steps: [
      { name: "checkout", conclusion: "success" },
      { name: "cargo test", conclusion: "failure" },
    ],
    ...overrides,
  }
}

export function workflowRunPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "completed",
    repository: { full_name: "acme/widgets" },
    workflow_run: {
      id: 1001,
      name: "ci",
      head_branch: "main",
      head_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      event: "push",
      status: "completed",
      conclusion: "failure",
      run_attempt: 1,
      html_url: "https://github.com/acme/widgets/actions/runs/1001",
      pull_requests: [],
      created_at: "2026-11-20T10:00:00Z",
      updated_at: "2026-11-20T10:02:14Z",
      ...overrides,
    },
  }
}

export function pushPayload(overrides: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    before: "0000000000000000000000000000000000000000",
    after: "b1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    forced: false,
    deleted: false,
    pusher: { name: "alice" },
    commits: [{}, {}, {}],
    head_commit: { message: "fix: retry backoff\n\nbody" },
    repository: { full_name: "acme/widgets" },
    ...overrides,
  }
}
