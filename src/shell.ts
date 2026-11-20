import { resolve } from "node:path"

const PUSH = /\bgit\s+(?:-C\s+\S+\s+)?push\b/

/** Directory a `git push` in this command applies to, or undefined when it is not a push. */
export function pushDirectory(command: string, workdir: string): string | undefined {
  if (!PUSH.test(command)) return undefined
  const explicit = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)\s+push\b/.exec(command)
  if (explicit?.[1]) return resolve(workdir, stripQuotes(explicit[1]))
  const pushAt = command.search(PUSH)
  const cd = /(?:^|&&|;|\|\|)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g
  let last: string | undefined
  for (const match of command.slice(0, pushAt).matchAll(cd)) last = match[1]
  if (last) return resolve(workdir, stripQuotes(last))
  return workdir
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "")
}
