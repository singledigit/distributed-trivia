/**
 * AppSync Events WebSocket client.
 *
 * Handles the AppSync Events realtime protocol:
 * - Base64URL-encoded auth in the connection query string
 * - connection_init / connection_ack handshake
 * - subscribe / data / ka message types
 * - Reconnect with exponential backoff
 *
 * Publishing uses the HTTP endpoint (POST), not WebSocket.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const config = {
  httpEndpoint: import.meta.env.VITE_APPSYNC_HTTP_ENDPOINT as string,
  realtimeEndpoint: import.meta.env.VITE_APPSYNC_REALTIME_ENDPOINT as string,
  apiKey: import.meta.env.VITE_APPSYNC_API_KEY as string,
}

function getHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    // For wss:// URLs, strip the protocol and path
    return endpoint.replace(/^wss?:\/\//, '').replace(/\/.*$/, '')
  }
}

// ---------------------------------------------------------------------------
// Base64URL helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EventCallback = (event: unknown) => void

interface Subscription {
  id: string
  channel: string
  callback: EventCallback
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 30_000

let ws: WebSocket | null = null
let connected = false
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let keepaliveTimer: ReturnType<typeof setTimeout> | null = null

const subscriptions = new Map<string, Subscription>()
const pendingSubscribes = new Map<string, { resolve: () => void; reject: (err: Error) => void }>()

// ---- connection helpers ---------------------------------------------------

function buildConnectionUrl(): string {
  return config.realtimeEndpoint
}

/**
 * Build the auth subprotocol string for the WebSocket connection.
 * Format: header-{base64url-encoded-json}
 */
function buildAuthProtocol(): string {
  const host = getHost(config.httpEndpoint)
  const headerJson = JSON.stringify({
    host,
    'x-api-key': config.apiKey,
  })
  return `header-${base64UrlEncode(headerJson)}`
}

function resetKeepalive(timeoutMs: number) {
  if (keepaliveTimer) clearTimeout(keepaliveTimer)
  keepaliveTimer = setTimeout(() => {
    // No keepalive received — connection is stale, reconnect
    console.warn('[appsync] keepalive timeout — reconnecting')
    ws?.close()
  }, timeoutMs)
}

function resubscribeAll() {
  for (const sub of subscriptions.values()) {
    sendSubscribe(sub.id, sub.channel).catch((err) => {
      console.error('[appsync] resubscribe failed', sub.channel, err)
    })
  }
}

function sendSubscribe(id: string, channel: string): Promise<void> {
  const host = getHost(config.httpEndpoint)
  const msg = JSON.stringify({
    type: 'subscribe',
    id,
    channel,
    authorization: {
      'x-api-key': config.apiKey,
      host,
    },
  })
  ws?.send(msg)

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingSubscribes.delete(id)
      reject(new Error('Subscribe timeout'))
    }, 10000)
    pendingSubscribes.set(id, {
      resolve: () => { clearTimeout(timeout); resolve() },
      reject: (err) => { clearTimeout(timeout); reject(err) },
    })
  })
}

// ---- connect / reconnect --------------------------------------------------

let connectPromise: Promise<void> | null = null

function connect(): Promise<void> {
  // If already connected, resolve immediately
  if (connected && ws?.readyState === WebSocket.OPEN) {
    return Promise.resolve()
  }

  // If connection is in progress, return the existing promise
  if (connectPromise) {
    return connectPromise
  }

  connectPromise = new Promise<void>((resolve, reject) => {
    const url = buildConnectionUrl()
    ws = new WebSocket(url, [buildAuthProtocol(), 'aws-appsync-event-ws'])

    let resolved = false

    ws.onopen = () => {
      ws!.send(JSON.stringify({ type: 'connection_init' }))
    }

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string)

      switch (msg.type) {
        case 'connection_ack': {
          const wasReconnect = reconnectAttempt > 0
          connected = true
          reconnectAttempt = 0
          resolved = true
          resetKeepalive((msg.connectionTimeoutMs ?? 300_000) as number)
          if (wasReconnect) {
            resubscribeAll()
          }
          resolve()
          connectPromise = null
          break
        }

        case 'ka':
          resetKeepalive(300_000)
          break

        case 'data': {
          const sub = subscriptions.get(msg.id as string)
          if (sub) {
            try {
              let parsed = typeof msg.event === 'string' ? JSON.parse(msg.event as string) : msg.event
              // AppSync Events double-encodes: the event is a JSON string inside a JSON string
              if (typeof parsed === 'string') {
                parsed = JSON.parse(parsed)
              }
              sub.callback(parsed)
            } catch {
              sub.callback(msg.event)
            }
          }
          break
        }

        case 'subscribe_success': {
          const pending = pendingSubscribes.get(msg.id as string)
          if (pending) {
            pending.resolve()
            pendingSubscribes.delete(msg.id as string)
          }
          break
        }

        case 'subscribe_error':
          console.error('[appsync] subscribe error', JSON.stringify(msg))
          {
            const pending = pendingSubscribes.get(msg.id as string)
            if (pending) {
              pending.reject(new Error(`Subscribe failed: ${JSON.stringify(msg.errors)}`))
              pendingSubscribes.delete(msg.id as string)
            }
          }
          break

        case 'error':
          console.error('[appsync] error', msg)
          break
      }
    }

    ws.onerror = (err) => {
      console.error('[appsync] ws error', err)
    }

    ws.onclose = () => {
      connected = false
      connectPromise = null
      if (keepaliveTimer) clearTimeout(keepaliveTimer)
      scheduleReconnect()
      if (!resolved) reject(new Error('WebSocket closed before connection_ack'))
    }
  })

  return connectPromise
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** reconnectAttempt, BACKOFF_MAX_MS)
  // Add jitter: ±25%
  const jitter = delay * (0.75 + Math.random() * 0.5)
  reconnectAttempt++
  console.log(`[appsync] reconnecting in ${Math.round(jitter)}ms (attempt ${reconnectAttempt})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect().catch(() => {
      // connect failure will trigger onclose → scheduleReconnect again
    })
  }, jitter)
}

// ---- public API -----------------------------------------------------------

/**
 * Subscribe to an AppSync Events channel.
 * Automatically connects if not already connected.
 *
 * @param channel - Channel path, e.g. "/admin/abc123"
 * @param callback - Called with each parsed event payload
 * @returns An unsubscribe function
 */
export async function subscribe(
  channel: string,
  callback: EventCallback,
): Promise<() => void> {
  const id = crypto.randomUUID()

  subscriptions.set(id, { id, channel, callback })

  if (!connected) {
    await connect()
  }
  // Always wait for subscribe confirmation
  await sendSubscribe(id, channel)

  return () => {
    subscriptions.delete(id)
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'unsubscribe', id }))
    }
  }
}

/**
 * Publish events to an AppSync Events channel via HTTP POST.
 *
 * Returns the parsed response body from AppSync, which includes
 * the onPublish handler's return values in the `events` array.
 *
 * @param channel - Channel path, e.g. "/admin/abc123"
 * @param events - Array of event payloads (will be JSON-stringified)
 * @returns The parsed JSON response from AppSync Events
 */
export async function publish(
  channel: string,
  events: unknown[],
): Promise<PublishResponse> {
  const body = JSON.stringify({
    channel,
    events: events.map((e) => JSON.stringify(e)),
  })

  const res = await fetch(config.httpEndpoint, {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      'Content-Type': 'application/json',
    },
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`AppSync publish failed (${res.status}): ${text}`)
  }

  return res.json() as Promise<PublishResponse>
}

export interface PublishResponseEvent {
  channelPath: string
  payload: string
}

export interface PublishResponse {
  events?: PublishResponseEvent[]
  failed?: Array<{ channelPath: string; error: string }>
}

/**
 * Disconnect the WebSocket and clean up all subscriptions.
 */
export function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (keepaliveTimer) {
    clearTimeout(keepaliveTimer)
    keepaliveTimer = null
  }
  subscriptions.clear()
  reconnectAttempt = 0
  connected = false
  if (ws) {
    ws.onclose = null // prevent reconnect
    ws.close()
    ws = null
  }
}
