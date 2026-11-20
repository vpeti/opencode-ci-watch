import type { Logger } from "./types.ts"

const secret = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g

export function redact(value: string): string {
  return value.replace(secret, "[redacted]")
}

function fmt(extra?: Record<string, unknown>): string {
  if (!extra) return ""
  const parts = Object.entries(extra).map(([key, value]) => `${key}=${String(value)}`)
  return parts.length > 0 ? ` ${parts.join(" ")}` : ""
}

export const logger: Logger = {
  info(message, extra) {
    process.stderr.write(`[ci-watch] ${redact(message)}${fmt(extra)}\n`)
  },
  warn(message, extra) {
    process.stderr.write(`[ci-watch] warn: ${redact(message)}${fmt(extra)}\n`)
  },
  error(message, extra) {
    process.stderr.write(`[ci-watch] error: ${redact(message)}${fmt(extra)}\n`)
  },
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return redact(error.message)
  return redact(String(error))
}
