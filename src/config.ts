import { readFile } from "node:fs/promises"
import { join } from "node:path"

export type DeliveryMode = "queue" | "steer"

export type AgentToolMode = "all" | "read" | "none"

export interface AgentRule {
  /** Which ci tools the agent may use. Default: all. */
  tools?: AgentToolMode
  /** false disables the generated note; a string replaces it. */
  instructions?: boolean | string
}

export interface NotifyConfig {
  /** Default for new subscriptions: wake on all-green, the signal that the work is done. */
  success: boolean
  /** How a failure enters the session: after the current step (queue) or into it (steer). */
  delivery: DeliveryMode
}

export interface Config {
  disabled: boolean
  account?: string
  repo?: string
  host: string
  notify: NotifyConfig
  autoSubscribe: { onPush: boolean }
  forwarder: { idleTimeoutMinutes: number; restartMax: number }
  maxLogChars: number
  waitTimeoutSeconds: number
  agents: Record<string, AgentRule>
}

export const PROJECT_CONFIG_PATH = ".opencode/ci-watch.json"

const DEFAULTS: Config = {
  disabled: false,
  host: "github.com",
  notify: { success: true, delivery: "queue" },
  autoSubscribe: { onPush: false },
  forwarder: { idleTimeoutMinutes: 30, restartMax: 5 },
  maxLogChars: 1200,
  waitTimeoutSeconds: 300,
  agents: {},
}

export class ConfigError extends Error {
  override name = "ConfigError"
}

type Raw = Record<string, unknown>

function object(value: unknown, path: string): Raw {
  if (value === undefined) return {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`)
  }
  return value as Raw
}

function str(value: unknown, path: string, fallback?: string): string | undefined {
  if (value === undefined) return fallback
  if (typeof value !== "string" || value.trim() === "") throw new ConfigError(`${path} must be a non-empty string`)
  return value.trim()
}

function bool(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new ConfigError(`${path} must be a boolean`)
  return value
}

function int(value: unknown, path: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${path} must be an integer between ${min} and ${max}`)
  }
  return value
}

function delivery(value: unknown, path: string, fallback: DeliveryMode): DeliveryMode {
  if (value === undefined) return fallback
  if (value !== "queue" && value !== "steer") throw new ConfigError(`${path} must be "queue" or "steer"`)
  return value
}

function agentMode(value: unknown, path: string, fallback: AgentToolMode): AgentToolMode {
  if (value === undefined) return fallback
  if (value !== "all" && value !== "read" && value !== "none") {
    throw new ConfigError(`${path} must be "all", "read" or "none"`)
  }
  return value
}

function agentRules(value: unknown): Record<string, AgentRule> {
  const source = object(value, "agents")
  const out: Record<string, AgentRule> = {}
  for (const [name, entry] of Object.entries(source)) {
    const path = `agents.${name}`
    if (entry === false) {
      out[name] = { tools: "none", instructions: false }
      continue
    }
    const rule = object(entry, path)
    const instructions = rule.instructions
    if (instructions !== undefined && typeof instructions !== "boolean" && typeof instructions !== "string") {
      throw new ConfigError(`${path}.instructions must be a boolean or a string`)
    }
    out[name] = {
      tools: agentMode(rule.tools, `${path}.tools`, "all"),
      instructions,
    }
  }
  return out
}

function truthy(value: string | undefined): boolean {
  if (value === undefined) return false
  const normal = value.trim().toLowerCase()
  return normal !== "" && normal !== "0" && normal !== "false" && normal !== "no" && normal !== "off"
}

/** Shallow merge with one level of nesting for the object-valued keys we own. */
function merge(base: Raw, extra: Raw): Raw {
  const out: Raw = { ...base }
  for (const key of ["notify", "autoSubscribe", "forwarder"]) {
    const left = base[key]
    const right = extra[key]
    if (right !== undefined) {
      out[key] = { ...(object(left, key)), ...(object(right, key)) }
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    if (key === "notify" || key === "autoSubscribe" || key === "forwarder") continue
    if (value !== undefined) out[key] = value
  }
  return out
}

async function readProjectConfig(directory: string): Promise<Raw> {
  try {
    const text = await readFile(join(directory, PROJECT_CONFIG_PATH), "utf8")
    const parsed: unknown = JSON.parse(text)
    return object(parsed, PROJECT_CONFIG_PATH)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === "ENOENT") return {}
    if (error instanceof SyntaxError) throw new ConfigError(`${PROJECT_CONFIG_PATH} is not valid JSON`)
    throw error
  }
}

export interface LoadConfigInput {
  directory: string
  options: unknown
  env?: Record<string, string | undefined>
}

export async function loadConfig(input: LoadConfigInput): Promise<Config> {
  const env = input.env ?? process.env
  const project = await readProjectConfig(input.directory)
  const raw = merge(merge(object(input.options, "plugin options"), project), {
    disabled: truthy(env.CI_WATCH_DISABLE) ? true : undefined,
    repo: env.CI_WATCH_REPO,
    account: env.CI_WATCH_ACCOUNT,
  })

  const notify = object(raw.notify, "notify")
  const autoSubscribe = object(raw.autoSubscribe, "autoSubscribe")
  const forwarder = object(raw.forwarder, "forwarder")
  const host = str(raw.host, "host", DEFAULTS.host) ?? DEFAULTS.host
  if (host !== "github.com") {
    throw new ConfigError(`host "${host}" is not supported yet; only github.com is supported`)
  }

  return {
    disabled: bool(raw.disabled, "disabled", DEFAULTS.disabled),
    account: str(raw.account, "account"),
    repo: str(raw.repo, "repo"),
    host,
    notify: {
      success: bool(notify.success, "notify.success", DEFAULTS.notify.success),
      delivery: delivery(notify.delivery, "notify.delivery", DEFAULTS.notify.delivery),
    },
    autoSubscribe: {
      onPush: bool(autoSubscribe.onPush, "autoSubscribe.onPush", DEFAULTS.autoSubscribe.onPush),
    },
    forwarder: {
      idleTimeoutMinutes: int(
        forwarder.idleTimeoutMinutes,
        "forwarder.idleTimeoutMinutes",
        DEFAULTS.forwarder.idleTimeoutMinutes,
        1,
        24 * 60,
      ),
      restartMax: int(forwarder.restartMax, "forwarder.restartMax", DEFAULTS.forwarder.restartMax, 0, 50),
    },
    maxLogChars: int(raw.maxLogChars, "maxLogChars", DEFAULTS.maxLogChars, 200, 4000),
    waitTimeoutSeconds: int(raw.waitTimeoutSeconds, "waitTimeoutSeconds", DEFAULTS.waitTimeoutSeconds, 15, 900),
    agents: agentRules(raw.agents),
  }
}
