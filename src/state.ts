import type { Include, NotifyMode } from "./store.ts"
import type { Target } from "./types.ts"

export interface CiJobState {
  readonly id: number
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
  readonly startedAt?: string
  readonly completedAt?: string
}

export interface CiRunState {
  readonly id: number
  readonly name: string
  readonly branch: string
  readonly sha: string
  readonly status: string
  readonly conclusion: string | null
  readonly url: string
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly jobCount: number
  readonly primary: boolean
}

export interface CiWatchState {
  readonly id: string
  readonly target: Target
  readonly include: readonly Include[]
  readonly notify: NotifyMode
  readonly merged: boolean
  readonly mergedAt?: number
  readonly run?: CiRunState
  readonly runs: readonly CiRunState[]
  readonly jobs: readonly CiJobState[]
}

export interface CiState {
  readonly defaultBranch: string
  readonly watches: readonly CiWatchState[]
}
