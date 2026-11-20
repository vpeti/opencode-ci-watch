import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { errorMessage, redact } from "../log.ts"

const run = promisify(execFile)

export interface GhOptions {
  readonly host: string
  readonly account?: string
  readonly cwd?: string
}

export interface ExecOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export class GhError extends Error {
  override name = "GhError"
  readonly code: number | undefined

  constructor(message: string, code?: number) {
    super(message)
    this.code = code
  }
}

function cleanEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env.GH_PAGER
  delete env.GIT_PAGER
  env.GH_NO_UPDATE_NOTIFIER = "1"
  env.NO_COLOR = "1"
  return env
}

export class Gh {
  private readonly options: GhOptions
  private tokenPromise: Promise<string | undefined> | undefined

  constructor(options: GhOptions) {
    this.options = options
  }

  get account(): string | undefined {
    return this.options.account
  }

  /** Reads the token for the configured account once, without mutating gh's active account. */
  token(): Promise<string | undefined> {
    const account = this.options.account
    if (!account) return Promise.resolve(undefined)
    this.tokenPromise ??= this.readToken(account).catch((error) => {
      this.tokenPromise = undefined
      throw error
    })
    return this.tokenPromise
  }

  private async readToken(account: string): Promise<string> {
    const env = cleanEnv()
    delete env.GH_TOKEN
    delete env.GITHUB_TOKEN
    try {
      const { stdout } = await run("gh", ["auth", "token", "--user", account, "--hostname", this.options.host], {
        env,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      })
      const token = stdout.trim()
      if (!token) throw new GhError(`no token for gh account "${account}" on ${this.options.host}`)
      return token
    } catch (error) {
      throw new GhError(
        `cannot read a token for gh account "${account}": ${errorMessage(error)}. ` +
          `Run \`gh auth login\` or pick another account.`,
      )
    }
  }

  private async env(): Promise<NodeJS.ProcessEnv> {
    const token = await this.token()
    return cleanEnv(token ? { GH_TOKEN: token } : undefined)
  }

  async exec(args: readonly string[], options: ExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
    const env = await this.env()
    try {
      const { stdout, stderr } = await run("gh", [...args], {
        env,
        cwd: this.options.cwd,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        signal: options.signal,
      })
      return { stdout, stderr }
    } catch (error) {
      if (options.signal?.aborted) throw new GhError("aborted")
      const candidate = error as { code?: number | string; stderr?: string; message?: string }
      const raw = candidate.stderr?.trim() || candidate.message || errorMessage(error)
      const detail = redact(raw.trim()).slice(0, 1200)
      const code = typeof candidate.code === "number" ? candidate.code : undefined
      throw new GhError(`\`gh ${args.join(" ")}\` failed${code === undefined ? "" : ` (${code})`}: ${detail}`, code)
    }
  }

  async text(args: readonly string[], options: ExecOptions = {}): Promise<string> {
    return (await this.exec(args, options)).stdout.trim()
  }

  async json<T>(args: readonly string[], options: ExecOptions = {}): Promise<T> {
    const output = await this.text(args, options)
    try {
      return JSON.parse(output) as T
    } catch {
      throw new GhError(`unexpected non-JSON output from \`gh ${args.join(" ")}\``)
    }
  }
}

export function isAuthError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  return (
    message.includes("gh auth token") ||
    message.includes("not logged in") ||
    message.includes("authentication") ||
    message.includes("http 401") ||
    message.includes(" 401 ")
  )
}
