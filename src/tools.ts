import type { Plugin } from "@opencode/plugin"
import { CiError, type CiService, type LogInput, type StatusInput, type WaitInput, type WatchInput } from "./service.ts"
import { errorMessage } from "./log.ts"
import type { DeliveryMode } from "./store.ts"

export interface ToolHandle {
  service?: CiService
  unavailable?: string
}

const NAMESPACE_DESCRIPTION =
  "GitHub Actions for this repository. Watch CI results for a branch, commit or run: failures are delivered " +
  "into the session with the failing job and a log excerpt, successes update a short status line. Use these " +
  "tools instead of polling `gh run list` or `gh pr checks`."

function object(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function num(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function bool(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key]
  return typeof value === "boolean" ? value : undefined
}

function strings(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key]
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === "string")
}

const targetProperties = {
  branch: { type: "string", description: "Branch name, for example `feature/login`." },
  sha: { type: "string", description: "Commit sha (7-40 hex characters)." },
  run: { type: "number", description: "Workflow run id." },
  current: { type: "boolean", description: "Use the branch checked out in this working copy." },
} as const

const TARGETS = "Pass exactly one of `branch`, `sha`, `run` or `current`; omit all to use the current branch."

export async function registerTools(ctx: Plugin.Context, handle: ToolHandle): Promise<void> {
  const guard = (): CiService => {
    if (!handle.service) {
      throw new CiError(handle.unavailable ?? "ci is not configured")
    }
    return handle.service
  }

  const run = async (body: () => Promise<{ content: string; metadata?: Record<string, unknown> }>) => {
    try {
      return await body()
    } catch (error) {
      if (error instanceof CiError) return { content: `error: ${error.message}` }
      return { content: `error: ${errorMessage(error)}` }
    }
  }

  await ctx.tool.transform((editor) => {
    editor.namespace({ name: "ci", description: NAMESPACE_DESCRIPTION })

    editor.add({
      name: "watch",
      description:
        "Subscribe this session to CI for a branch, commit or run. A failed run wakes you with the failing job " +
        "and a log excerpt; a green run only updates the status line (unless `notify: all`). Call it after pushing. " +
        "For an orchestrator watching merges, watch the branch with `include: [\"pushes\"]`, read the sha from the " +
        `notification, then watch \`sha\` only for the merges you care about. ${TARGETS}`,
      input: {
        type: "object",
        properties: {
          ...targetProperties,
          include: {
            type: "array",
            items: { type: "string", enum: ["runs", "pushes"] },
            description: "`runs` (default) reports workflow results; `pushes` reports every push to the branch.",
          },
          notify: {
            type: "string",
            enum: ["failures", "all", "none"],
            description: "`failures` (default) wakes you when a run fails; `all` also on success; `none` only updates the status line.",
          },
          delivery: {
            type: "string",
            enum: ["queue", "steer"],
            description: "`queue` (default) delivers after the current step; `steer` injects into the running step.",
          },
          ttlMinutes: { type: "number", description: "How long to watch (default 1440, max 10080)." },
        },
        additionalProperties: false,
      },
      options: { namespace: "ci", codemode: true },
      execute: async (raw, context) => {
        const input = object(raw)
        return run(() =>
          guard().watch(context.sessionID, {
            branch: str(input, "branch"),
            sha: str(input, "sha"),
            run: num(input, "run"),
            current: bool(input, "current"),
            include: strings(input, "include") as WatchInput["include"],
            notify: str(input, "notify") as WatchInput["notify"],
            delivery: str(input, "delivery") as DeliveryMode | undefined,
            ttlMinutes: num(input, "ttlMinutes"),
          }),
        )
      },
    })

    editor.add({
      name: "unwatch",
      description:
        "Stop watching a target, or every target this session watches. Pass `id` from `ci_watch`, a target, or `all: true`.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", description: "Subscription id returned by ci_watch." },
          ...targetProperties,
          all: { type: "boolean", description: "Remove every subscription for this session." },
        },
        additionalProperties: false,
      },
      options: { namespace: "ci", codemode: true },
      execute: async (raw, context) => {
        const input = object(raw)
        return run(() =>
          guard().unwatch(context.sessionID, {
            id: str(input, "id"),
            branch: str(input, "branch"),
            sha: str(input, "sha"),
            run: num(input, "run"),
            all: bool(input, "all"),
          }),
        )
      },
    })

    editor.add({
      name: "status",
      description:
        "Current CI state for a branch, commit or run: latest runs, per-job results, and optionally the failing " +
        `log excerpt. Use for a deliberate check, not in a loop. ${TARGETS}`,
      input: {
        type: "object",
        properties: {
          ...targetProperties,
          recent: { type: "number", description: "How many recent runs to show (default 3, max 10)." },
          include: {
            type: "array",
            items: { type: "string", enum: ["jobs", "logs"] },
            description: "`jobs` lists per-job results; `logs` adds the failing log excerpt.",
          },
        },
        additionalProperties: false,
      },
      options: { namespace: "ci", codemode: true },
      execute: async (raw) => {
        const input = object(raw)
        return run(() =>
          guard().status({
            branch: str(input, "branch"),
            sha: str(input, "sha"),
            run: num(input, "run"),
            current: bool(input, "current"),
            recent: num(input, "recent"),
            include: strings(input, "include") as StatusInput["include"],
          }),
        )
      },
    })

    editor.add({
      name: "wait",
      description:
        "Block until a branch, commit or run reaches a CI result, up to `timeoutSeconds` (default 300, max 900). " +
        "Prefer `ci_watch` for background work; use this only when you cannot continue without the result. " +
        `Waiting here suppresses duplicate notifications for the same target. ${TARGETS}`,
      input: {
        type: "object",
        properties: {
          ...targetProperties,
          timeoutSeconds: { type: "number", description: "Maximum wait (default 300, max 900)." },
        },
        additionalProperties: false,
      },
      options: { namespace: "ci", codemode: true },
      execute: async (raw, context) => {
        const input = object(raw)
        return run(() =>
          guard().wait(
            context.sessionID,
            {
              branch: str(input, "branch"),
              sha: str(input, "sha"),
              run: num(input, "run"),
              current: bool(input, "current"),
              timeoutSeconds: num(input, "timeoutSeconds"),
            } satisfies WaitInput,
            context.signal,
          ),
        )
      },
    })

    editor.add({
      name: "log",
      description:
        "Failing log excerpt for a workflow run or job, trimmed around the error. Use it when the notification " +
        "excerpt is not enough.",
      input: {
        type: "object",
        properties: {
          run: { type: "number", description: "Workflow run id." },
          job: { type: "number", description: "Job id (defaults to the first failed job)." },
          maxChars: { type: "number", description: "Excerpt budget in characters (default 1200, max 4000)." },
        },
        required: ["run"],
        additionalProperties: false,
      },
      options: { namespace: "ci", codemode: true },
      execute: async (raw) => {
        const input = object(raw)
        const id = num(input, "run")
        if (id === undefined) return { content: "error: `run` is required" }
        return run(() =>
          guard().logs({
            run: id,
            job: num(input, "job"),
            maxChars: num(input, "maxChars"),
          } satisfies LogInput),
        )
      },
    })
  })
}
