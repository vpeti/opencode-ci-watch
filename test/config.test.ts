import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ConfigError, loadConfig } from "../src/config.ts"

async function project(config?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ci-watch-config-"))
  if (config !== undefined) {
    await mkdir(join(dir, ".opencode"))
    await writeFile(join(dir, ".opencode", "ci-watch.json"), JSON.stringify(config))
  }
  return dir
}

test("defaults are conservative", async () => {
  const config = await loadConfig({ directory: await project(), options: {}, env: {} })
  assert.equal(config.disabled, false)
  assert.equal(config.host, "github.com")
  assert.equal(config.notify.success, true)
  assert.equal(config.notify.delivery, "queue")
  assert.equal(config.autoSubscribe.onPush, false)
  assert.equal(config.maxLogChars, 1200)
  assert.equal(config.waitTimeoutSeconds, 300)
})

test("project config overrides plugin options, env overrides both", async () => {
  const directory = await project({
    repo: "acme/project",
    account: "project-account",
    notify: { success: true },
    autoSubscribe: { onPush: true },
  })
  const config = await loadConfig({
    directory,
    options: { repo: "acme/options", account: "option-account", maxLogChars: 900 },
    env: { CI_WATCH_REPO: "acme/env" },
  })
  assert.equal(config.repo, "acme/env")
  assert.equal(config.account, "project-account")
  assert.equal(config.notify.success, true)
  assert.equal(config.autoSubscribe.onPush, true)
  assert.equal(config.maxLogChars, 900)
})

test("parses per-agent rules", async () => {
  const config = await loadConfig({
    directory: await project({ agents: { "*": { tools: "read" }, build: { instructions: "custom" }, plan: false } }),
    options: {},
    env: {},
  })
  assert.deepEqual(config.agents["*"], { tools: "read", instructions: undefined })
  assert.deepEqual(config.agents.build, { tools: "all", instructions: "custom" })
  assert.deepEqual(config.agents.plan, { tools: "none", instructions: false })
})

test("rejects an unknown agent tool mode", async () => {
  await assert.rejects(
    loadConfig({ directory: await project({ agents: { build: { tools: "write" } } }), options: {}, env: {} }),
    ConfigError,
  )
})

test("CI_WATCH_DISABLE turns the plugin off", async () => {
  const config = await loadConfig({ directory: await project(), options: {}, env: { CI_WATCH_DISABLE: "1" } })
  assert.equal(config.disabled, true)
})

test("rejects unsupported hosts and bad values", async () => {
  await assert.rejects(
    loadConfig({ directory: await project({ host: "github.example.com" }), options: {}, env: {} }),
    ConfigError,
  )
  await assert.rejects(
    loadConfig({ directory: await project({ notify: { delivery: "later" } }), options: {}, env: {} }),
    ConfigError,
  )
  await assert.rejects(
    loadConfig({ directory: await project({ maxLogChars: 99 }), options: {}, env: {} }),
    ConfigError,
  )
})
