export interface RepoRef {
  readonly owner: string
  readonly name: string
  readonly slug: string
}

export type TargetType = "branch" | "sha" | "run"

export interface Target {
  readonly type: TargetType
  readonly value: string
}

export interface RunInfo {
  readonly id: number
  readonly name: string
  readonly branch: string
  readonly sha: string
  readonly event: string
  readonly status: string
  readonly conclusion: string | null
  readonly attempt: number
  readonly url: string
  readonly pullRequests: number[]
  readonly createdAt?: string
  readonly updatedAt?: string
}

export interface JobStep {
  readonly name: string
  readonly conclusion: string | null
}

export interface JobInfo {
  readonly id: number
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
  readonly url: string
  readonly steps: readonly JobStep[]
}

export interface PushInfo {
  readonly branch: string
  readonly before: string
  readonly after: string
  readonly forced: boolean
  readonly deleted: boolean
  readonly actor: string
  readonly commits: number
  readonly headline: string
}

export type Delivery =
  | { readonly kind: "push"; readonly repo: RepoRef; readonly push: PushInfo }
  | { readonly kind: "workflow_run"; readonly repo: RepoRef; readonly run: RunInfo }

export interface WebhookDelivery {
  readonly event: string
  readonly id: string
  readonly payload: unknown
}

export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}
