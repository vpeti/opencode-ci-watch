import type { Plugin } from "@opencode/plugin"
import type { AgentRule, AgentToolMode, Config } from "./config.ts"

export const TOOL_NAMES = ["ci_watch", "ci_unwatch", "ci_status", "ci_wait", "ci_log"] as const

const READ_ONLY = new Set<string>(["ci_status", "ci_log"])

export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny"
}

/** Deny rules for the tools an agent in this mode may not use. */
export function deniedTools(mode: AgentToolMode): PermissionRule[] {
  if (mode === "all") return []
  return TOOL_NAMES.filter((name) => (mode === "read" ? !READ_ONLY.has(name) : true)).map((action) => ({
    action,
    resource: "*",
    effect: "deny" as const,
  }))
}

export function agentNote(mode: AgentToolMode): string | undefined {
  if (mode === "all") {
    return (
      "GitHub Actions: this repository exposes the `ci` tools. After pushing a branch, call the watch " +
      "tool (`ci.watch` in Code Mode, `ci_watch` outside it) for that branch (or `current: true`) instead " +
      "of polling `gh`. Failures arrive with the failing job and a log excerpt; green runs only update the " +
      'status entry. When coordinating merges, watch the branch with `include: ["pushes"]` and follow only ' +
      "the commits that matter to you."
    )
  }
  if (mode === "read") {
    return "GitHub Actions: use the status and log tools (`ci.status`/`ci.log`, or `ci_status`/`ci_log` outside Code Mode) for deliberate checks. Watching is disabled for this agent; do not poll `gh`."
  }
  return undefined
}

function merge(base: AgentRule, specific: AgentRule): AgentRule {
  return { ...base, ...specific }
}

/** Resolves `*` defaults and per-agent overrides. */
export function ruleFor(agents: Record<string, AgentRule>, agentID: string): AgentRule | undefined {
  const base = agents["*"]
  const specific = agents[agentID]
  if (base === undefined && specific === undefined) return undefined
  return merge(base ?? {}, specific ?? {})
}

export async function applyAgentTransforms(ctx: Plugin.Context, config: Config): Promise<void> {
  const entries = Object.entries(config.agents)
  if (entries.length === 0) return

  await ctx.agent.transform((editor) => {
    for (const agent of editor.list()) {
      const rule = ruleFor(config.agents, agent.id)
      if (!rule) continue
      const mode = rule.tools ?? "all"
      const denied = deniedTools(mode)
      const note =
        rule.instructions === false
          ? undefined
          : typeof rule.instructions === "string"
            ? rule.instructions
            : agentNote(mode)
      if (denied.length === 0 && !note) continue
      editor.update(agent.id, (target) => {
        if (denied.length > 0) target.permissions = [...(target.permissions ?? []), ...denied]
        if (note) target.system = [target.system, note].filter(Boolean).join("\n\n")
      })
    }
  })
}
