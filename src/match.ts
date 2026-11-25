import type { Subscription } from "./store.ts"
import type { JobInfo, PushInfo, RunInfo, Target } from "./types.ts"

export function targetKey(target: Target): string {
  return `${target.type}:${target.value.toLowerCase()}`
}

export function describeTarget(target: Target): string {
  if (target.type === "sha") return `sha ${target.value.slice(0, 7)}`
  if (target.type === "run") return `run ${target.value}`
  return target.value
}

function sameSha(value: string, sha: string): boolean {
  return sha.toLowerCase().startsWith(value.toLowerCase())
}

export function matchesRun(subscription: Subscription, run: RunInfo): boolean {
  if (!subscription.include.includes("runs")) return false
  const target = subscription.target
  if (target.type === "branch") return run.branch === target.value
  if (target.type === "sha") return sameSha(target.value, run.sha)
  return String(run.id) === target.value
}

/** Matches a job before the parent run is cached; the run supplies only fallbacks. */
export function matchesJob(subscription: Subscription, job: JobInfo, run?: RunInfo): boolean {
  if (!subscription.include.includes("runs")) return false
  const target = subscription.target
  if (target.type === "branch") {
    const branch = job.branch || run?.branch || ""
    return branch !== "" && branch === target.value
  }
  if (target.type === "sha") {
    const sha = job.sha || run?.sha || ""
    return sha !== "" && sameSha(target.value, sha)
  }
  const id = job.runId ?? run?.id
  return id !== undefined && String(id) === target.value
}

export function matchesPush(subscription: Subscription, push: PushInfo): boolean {
  if (!subscription.include.includes("pushes")) return false
  const target = subscription.target
  if (target.type === "branch") return push.branch === target.value
  if (target.type === "sha") return sameSha(target.value, push.after)
  return false
}

export function targetMatchesDelivery(target: Target, delivery: { run?: RunInfo; push?: PushInfo }): boolean {
  if (target.type === "run") return delivery.run !== undefined && String(delivery.run.id) === target.value
  if (target.type === "sha") {
    if (delivery.run) return sameSha(target.value, delivery.run.sha)
    if (delivery.push) return sameSha(target.value, delivery.push.after)
    return false
  }
  if (delivery.run) return delivery.run.branch === target.value
  if (delivery.push) return delivery.push.branch === target.value
  return false
}
