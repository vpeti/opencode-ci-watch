import { Rpc } from "@opencode/plugin/rpc"

export type { CiJobState, CiRunState, CiState, CiWatchState } from "./state.ts"

const target = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["branch", "sha", "run"] },
    value: { type: "string" },
  },
  required: ["type", "value"],
  additionalProperties: false,
}

const run = {
  type: "object",
  properties: {
    id: { type: "number" },
    name: { type: "string" },
    branch: { type: "string" },
    sha: { type: "string" },
    status: { type: "string" },
    conclusion: { type: ["string", "null"] },
    url: { type: "string" },
    startedAt: { type: "string" },
    finishedAt: { type: "string" },
    jobCount: { type: "number" },
    primary: { type: "boolean" },
  },
  required: ["id", "name", "branch", "sha", "status", "conclusion", "url", "jobCount", "primary"],
  additionalProperties: false,
}

const job = {
  type: "object",
  properties: {
    id: { type: "number" },
    name: { type: "string" },
    status: { type: "string" },
    conclusion: { type: ["string", "null"] },
    startedAt: { type: "string" },
    completedAt: { type: "string" },
  },
  required: ["id", "name", "status", "conclusion"],
  additionalProperties: false,
}

const watch = {
  type: "object",
  properties: {
    id: { type: "string" },
    target,
    include: { type: "array", items: { type: "string", enum: ["runs", "pushes"] } },
    notify: { type: "string", enum: ["failures", "all", "none"] },
    merged: { type: "boolean" },
    mergedAt: { type: "number" },
    run,
    runs: { type: "array", items: run },
    jobs: { type: "array", items: job },
  },
  required: ["id", "target", "include", "notify", "merged", "runs", "jobs"],
  additionalProperties: false,
}

export const CiRpc = Rpc.define({
  id: "ci",
  methods: {
    state: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          defaultBranch: { type: "string" },
          watches: { type: "array", items: watch },
        },
        required: ["defaultBranch", "watches"],
        additionalProperties: false,
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
  },
})
