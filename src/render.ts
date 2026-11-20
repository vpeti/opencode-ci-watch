import type { JobInfo, PushInfo, RunInfo } from "./types.js"

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/

const EMOJI: Record<string, string> = {
  success: "✅",
  failure: "❌",
  timed_out: "⏱️",
  cancelled: "⊘",
  skipped: "⏭️",
  action_required: "⚠️",
  neutral: "⚪",
  stale: "⚪",
}

export function conclusionEmoji(conclusion: string | null): string {
  if (!conclusion) return "⏳"
  return EMOJI[conclusion] ?? "❔"
}

export function duration(run: RunInfo): string {
  if (!run.createdAt || !run.updatedAt) return ""
  const start = Date.parse(run.createdAt)
  const end = Date.parse(run.updatedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return ""
  return formatDuration(end - start)
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60}m`
}

export function relativeTime(iso: string | undefined, now: number): string {
  if (!iso) return ""
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ""
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return "just now"
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

function runTitle(run: RunInfo): string {
  const name = clip(run.name, 24)
  return run.branch ? `${name} ${run.branch}` : name
}

export function renderRunLine(run: RunInfo, now = Date.now()): string {
  const emoji = conclusionEmoji(run.conclusion)
  const elapsed = duration(run)
  const age = relativeTime(run.updatedAt ?? run.createdAt, now)
  const parts = [`${emoji} ${runTitle(run)} · r${run.id}`]
  if (run.conclusion) parts.push(run.conclusion)
  if (elapsed) parts.push(elapsed)
  else if (age) parts.push(age)
  return parts.join(" · ")
}

export function renderSuccess(run: RunInfo): string {
  const parts = [`✅ ${runTitle(run)} · r${run.id} · success`]
  const elapsed = duration(run)
  if (elapsed) parts.push(elapsed)
  return parts.join(" · ")
}

export function renderFailure(run: RunInfo, jobs: readonly JobInfo[], excerpt?: { text: string; job?: string; step?: string }): string {
  const failed = jobs.filter((job) => job.conclusion === "failure" || job.conclusion === "timed_out")
  const header = [`❌ ${runTitle(run)} · r${run.id}`]
  if (failed.length > 0) {
    const names = failed.slice(0, 4).map((job) => clip(job.name, 20)).join(", ")
    header.push(`${failed.length}/${jobs.length} jobs failed${names ? ` (${names})` : ""}`)
  } else if (run.conclusion) {
    header.push(run.conclusion)
  }
  const elapsed = duration(run)
  if (elapsed) header.push(elapsed)

  const lines = [header.join(" · ")]
  const first = failed[0]
  const fallbackStep = first?.steps.find((step) => step.conclusion === "failure" || step.conclusion === "timed_out")
  const step = excerpt?.step ?? fallbackStep?.name
  const jobName = excerpt?.job ?? first?.name
  if (jobName) {
    lines.push(`✗ ${clip(jobName, 40)}${step ? ` · step "${clip(step, 48)}"` : ""}`)
  }
  if (excerpt?.text) {
    for (const line of excerpt.text.split("\n")) lines.push(`  ${line}`)
  }
  lines.push(`↳ gh run view ${run.id} --log-failed`)
  return lines.join("\n")
}

export function renderPush(push: PushInfo): string {
  const sha = shortSha(push.after)
  if (push.deleted) return `🗑️ ${push.branch} · branch deleted by ${push.actor}`
  const parts = [`⤴️ ${push.branch} · ${sha}`]
  if (push.forced) parts.push("force-push")
  parts.push(`${push.commits} ${push.commits === 1 ? "commit" : "commits"}`)
  parts.push(push.actor)
  if (push.headline) parts.push(`"${clip(push.headline, 60)}"`)
  return parts.join(" · ")
}

export function renderJobs(jobs: readonly JobInfo[]): string[] {
  return jobs.map((job) => {
    const emoji = conclusionEmoji(job.conclusion)
    const step = job.steps.find((entry) => entry.conclusion === "failure" || entry.conclusion === "timed_out")
    return `${emoji} ${clip(job.name, 40)}${step ? ` · step "${clip(step.name, 40)}"` : ""}`
  })
}

function cleanLine(line: string): string {
  return line.replace(ANSI, "").replace(/\r$/, "")
}

const ERROR_PATTERN = /(##\[error\]|\berror(\[|:|\s)|Error:|panic:|FAILED|assertion|fatal:)/

export interface TrimmedLog {
  text: string
  job?: string
  step?: string
}

/** Keeps the interesting part of `gh run view --log-failed` output. */
export function trimLog(raw: string, maxChars: number): TrimmedLog {
  const parsed: Array<{ content: string; job?: string; step?: string }> = []
  for (const rawLine of raw.split("\n")) {
    const line = cleanLine(rawLine)
    if (line.trim() === "") continue
    const match = /^([^\t]*)\t([^\t]*)\t(.*)$/.exec(line)
    if (match) {
      parsed.push({
        job: match[1] || undefined,
        step: match[2] || undefined,
        content: (match[3] ?? "").replace(TIMESTAMP, ""),
      })
    } else {
      parsed.push({ content: line.replace(TIMESTAMP, "") })
    }
  }
  if (parsed.length === 0) return { text: "" }

  const errorIndex = parsed.findIndex((entry) => ERROR_PATTERN.test(entry.content))
  const interesting = errorIndex === -1 ? undefined : parsed[errorIndex]
  const firstTagged = parsed.find((entry) => entry.job)

  let text: string
  if (errorIndex === -1) {
    text = parsed
      .slice(Math.max(0, parsed.length - 40))
      .map((entry) => entry.content.trimEnd())
      .join("\n")
    if (text.length > maxChars) {
      text = `… (truncated)\n${text.slice(text.length - Math.max(0, maxChars - 16))}`
    }
  } else {
    text = parsed
      .slice(Math.max(0, errorIndex - 1))
      .map((entry) => entry.content.trimEnd())
      .join("\n")
    if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 16))}\n… (truncated)`
  }

  return { text, job: interesting?.job ?? firstTagged?.job, step: interesting?.step ?? firstTagged?.step }
}
