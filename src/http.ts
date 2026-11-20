import { createHmac, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Logger } from "./types.ts"

const MAX_BODY = 1024 * 1024
const DEDUPE_TTL_MS = 10 * 60 * 1000

export interface WebhookServerOptions {
  readonly secret: string
  readonly allowedEvents: readonly string[]
  readonly onDelivery: (event: string, deliveryId: string, payload: unknown) => void
  readonly log: Logger
}

export interface WebhookServer {
  readonly port: number
  close(): Promise<void>
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export function verifySignature(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (!signature) return false
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
  const left = Buffer.from(expected, "utf8")
  const right = Buffer.from(signature, "utf8")
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error("payload too large"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks)))
    request.on("error", reject)
  })
}

function reply(response: ServerResponse, status: number, text: string): void {
  if (response.writableEnded) return
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" })
  response.end(text)
}

export async function startWebhookServer(options: WebhookServerOptions): Promise<WebhookServer> {
  const seen = new Map<string, number>()

  const prune = () => {
    const cutoff = Date.now() - DEDUPE_TTL_MS
    for (const [id, at] of seen) if (at < cutoff) seen.delete(id)
  }

  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") return reply(response, 405, "method not allowed")
      if (request.url !== "/hook") return reply(response, 404, "not found")

      let body: Buffer
      try {
        body = await readBody(request)
      } catch {
        return reply(response, 413, "payload too large")
      }

      if (!verifySignature(options.secret, body, header(request, "x-hub-signature-256"))) {
        options.log.warn("rejected webhook with a bad signature")
        return reply(response, 401, "bad signature")
      }

      const event = header(request, "x-github-event") ?? ""
      const deliveryId = header(request, "x-github-delivery") ?? ""
      if (!options.allowedEvents.includes(event)) return reply(response, 202, "ignored")
      if (!deliveryId) return reply(response, 400, "missing delivery id")

      if (seen.has(deliveryId)) return reply(response, 202, "duplicate")
      seen.set(deliveryId, Date.now())
      if (seen.size > 512) prune()

      reply(response, 202, "accepted")

      let payload: unknown
      try {
        payload = JSON.parse(body.toString("utf8"))
      } catch {
        options.log.warn("ignored webhook with invalid JSON", { event, delivery: deliveryId })
        return
      }
      try {
        options.onDelivery(event, deliveryId, payload)
      } catch (error) {
        options.log.error("webhook handler failed", { event, error: String(error) })
      }
    })().catch((error) => {
      options.log.error("webhook request failed", { error: String(error) })
      reply(response, 500, "internal error")
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address && typeof address === "object") resolve(address.port)
      else reject(new Error("could not determine webhook port"))
    })
  })

  server.unref()

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
