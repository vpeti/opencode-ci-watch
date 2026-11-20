import assert from "node:assert/strict"
import test from "node:test"
import { pushDirectory } from "../src/shell.ts"

const root = "/work/project"

test("finds the directory of a plain push", () => {
  assert.equal(pushDirectory("git push", root), root)
  assert.equal(pushDirectory("cargo test && git push -u origin main", root), root)
})

test("follows cd before the push", () => {
  assert.equal(pushDirectory("cd ../other && git push", root), "/work/other")
  assert.equal(pushDirectory('cd "/work/space dir" && git push', root), "/work/space dir")
})

test("follows git -C", () => {
  assert.equal(pushDirectory("git -C ../other push", root), "/work/other")
})

test("ignores commands that are not pushes", () => {
  assert.equal(pushDirectory("git status", root), undefined)
  assert.equal(pushDirectory("git push --dry-run", root), root)
})
