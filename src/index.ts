import { randomBytes } from "node:crypto"
import { Plugin, Skill } from "@opencode/plugin"
import { applyAgentTransforms, ruleFor } from "./agents.ts"
import { loadConfig, type Config } from "./config.ts"
import { normalizeDelivery } from "./events.ts"
import { Forwarder } from "./forwarder.ts"
import { listAccounts, resolveAccount } from "./github/accounts.ts"
import { Enricher } from "./github/enrich.ts"
import { Gh } from "./github/gh.ts"
import { DevHookTracker } from "./github/hooks.ts"
import { currentGitBranch, resolveRepo, sameRepo } from "./github/repo.ts"
import { startWebhookServer } from "./http.ts"
import { errorMessage, logger } from "./log.ts"
import { Notifier, type SessionApiLike } from "./notify.ts"
import { CiRpc } from "./rpc.ts"
import { CiService } from "./service.ts"
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_ID, SKILL_NAME, SKILL_PATH } from "./skill.ts"
import { pushDirectory } from "./shell.ts"
import { JobCache, RunCache, SubscriptionStore, type StorageLike } from "./store.ts"
import { registerTools } from "./tools.ts"

const EVENTS = ["push", "workflow_run", "workflow_job", "pull_request"] as const


async function registerSkill(ctx: Plugin.Context): Promise<void> {
  await ctx.skill.transform((editor) => {
    editor.add({
      id: Skill.ID.make(SKILL_ID),
      name: Skill.Name.make(SKILL_NAME),
      description: SKILL_DESCRIPTION,
      path: Skill.Info.fields.path.make(SKILL_PATH),
      content: SKILL_CONTENT,
      autoinvoke: true,
    })
  })
}

export default Plugin.define({
  id: "ci",
  async setup(ctx) {
    const directory = ctx.location.directory as string

    let config: Config
    try {
      config = await loadConfig({ directory, options: ctx.options })
    } catch (error) {
      logger.error("invalid configuration; ci tools stay disabled", { error: errorMessage(error) })
      return
    }

    if (config.disabled) {
      logger.info("disabled by configuration")
      return
    }

    const resolved = await resolveRepo({ directory, explicit: config.repo, host: config.host })
    if (!resolved.ok) {
      logger.info(`${resolved.message}; ci tools stay disabled`)
      return
    }
    const repo = resolved.repo

    let account: string | undefined
    if (config.account) {
      const accounts = await listAccounts(config.host).catch(() => [] as string[])
      if (accounts.includes(config.account)) {
        account = config.account
      } else {
        const message = `configured gh account "${config.account}" is not logged in${
          accounts.length > 0 ? ` (available: ${accounts.join(", ")})` : ""
        }`
        logger.error(`${message}; ci tools stay disabled`)
        return
      }
    } else {
      const choice = await resolveAccount({ host: config.host, slug: repo.slug })
      if (choice.ok) {
        account = choice.account
      } else {
        logger.warn(`${choice.message}; using the active gh account`)
      }
    }

    const gh = new Gh({ host: config.host, account, cwd: directory })
    let token: string | undefined
    if (account) {
      try {
        token = await gh.token()
      } catch (error) {
        const message = errorMessage(error)
        logger.error(`${message}; ci tools stay disabled`)
        return
      }
    }

    let defaultBranch = "main"
    try {
      const value = await gh.text(["api", `repos/${repo.slug}`, "--jq", ".default_branch"], { timeoutMs: 15_000 })
      if (value) defaultBranch = value
    } catch (error) {
      logger.warn("cannot read the default branch; assuming main", { error: errorMessage(error) })
    }

    const secret = randomBytes(32).toString("hex")
    let service: CiService | undefined
    let emitState: ((sessionID: string) => void) | undefined

    let server: Awaited<ReturnType<typeof startWebhookServer>>
    try {
      server = await startWebhookServer({
        secret,
        allowedEvents: EVENTS,
        log: logger,
        onDelivery: (event, id, payload) => {
          if (process.env.CI_WATCH_DEBUG) logger.info("webhook", { event, id })
          const delivery = normalizeDelivery(event, payload)
          if (!delivery) return
          if (delivery.repo.slug !== repo.slug) {
            logger.warn("ignored an event from another repository", { repo: delivery.repo.slug, delivery: id })
            return
          }
          void service?.onDelivery(delivery).catch((error) => {
            logger.error("failed to handle a delivery", { error: errorMessage(error), delivery: id })
          })
        },
      })
    } catch (error) {
      logger.error(`cannot start the local webhook server: ${errorMessage(error)}; ci tools stay disabled`)
      return
    }

    const hooks = new DevHookTracker(gh, repo.slug, logger)
    const forwarder = new Forwarder({
      repo: repo.slug,
      url: `http://127.0.0.1:${server.port}/hook`,
      secret,
      events: EVENTS,
      token,
      restartMax: config.forwarder.restartMax,
      log: logger,
      beforeStart: () => hooks.snapshot(),
      onAttached: () => hooks.adopt(),
      onStopped: () => hooks.removeOwned(),
    })

    const store = new SubscriptionStore(ctx.storage as unknown as StorageLike, repo.slug)
    const notifier = new Notifier(ctx.session as unknown as SessionApiLike, logger)
    const ci = new CiService({
      repo,
      config,
      enricher: new Enricher(gh, repo),
      store,
      cache: new RunCache(),
      jobs: new JobCache(),
      defaultBranch,
      notifier,
      forwarder,
      log: logger,
      currentBranch: () => currentGitBranch(directory),
      onStateChanged: (sessionID) => emitState?.(sessionID),
    })
    service = ci

    try {
      const registration = await ctx.rpc.register(CiRpc, {
        state: async (input) => ci.state((input as { sessionID: string }).sessionID),
      })
      emitState = (sessionID) => {
        void registration.events.emit("updated", { sessionID }).catch((error) => {
          logger.warn("cannot emit ci state", { error: errorMessage(error) })
        })
      }
    } catch (error) {
      logger.warn("cannot register the CI state RPC", { error: errorMessage(error) })
    }

    try {
      await ci.start()
    } catch (error) {
      logger.error("cannot restore subscriptions", { error: errorMessage(error) })
    }

    await registerTools(ctx, ci)
    await registerSkill(ctx)
    try {
      await applyAgentTransforms(ctx, config)
    } catch (error) {
      logger.warn("cannot apply agent transforms", { error: errorMessage(error) })
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: ["session.deleted"], signal: controller.signal })) {
          const sessionID = (event.data as { sessionID?: string } | undefined)?.sessionID
          if (sessionID) await ci.forgetSession(sessionID)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          logger.warn("session event stream ended", { error: errorMessage(error) })
        }
      }
    })()

    if (config.autoSubscribe.onPush) {
      await ctx.tool.hook("execute.after", async (event) => {
        if (event.tool !== "shell" || event.status !== "completed") return
        const rule = ruleFor(config.agents, event.agent)
        if (rule?.tools && rule.tools !== "all") return
        const input = event.input as { command?: unknown; workdir?: unknown } | undefined
        const command = input?.command
        if (typeof command !== "string") return
        if (/--dry-run|(?:^|\s)-n(?:\s|$)/.test(command)) return
        const workdir = typeof input?.workdir === "string" ? input.workdir : directory
        const target = pushDirectory(command, workdir)
        if (!target) return
        if (!(await sameRepo(directory, target))) return
        void ci.autoSubscribe(event.sessionID).catch((error) => {
          logger.warn("auto-subscribe failed", { error: errorMessage(error) })
        })
      })
    }

    logger.info("ready", { repo: repo.slug, account: account ?? "active", port: server.port })

    return async () => {
      controller.abort()
      for (const sessionID of new Set(store.list().map((entry) => entry.sessionID))) {
        await notifier.setStatus(sessionID, undefined)
      }
      await ci.stop()
      await hooks.removeOwned()
      await server.close()
      logger.info("stopped")
    }
  },
})
