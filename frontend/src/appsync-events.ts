/**
 * AppSync Events WebSocket client.
 *
 * Supports dual auth: API_KEY (default) and Cognito JWT (for admin channels).
 *
 * - WebSocket connection uses API_KEY auth
 * - Subscribe/publish to admin channels uses Cognito JWT when available
 * - Player/game/leaderboard channels use API_KEY
 */

import { getIdToken } from './auth'

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
// Auth helpers
// ---------------------------------------------------------------------------

function isAdminChannel(channel: string): boolean {
  return channel.startsWith('/admin') || channel.startsWith('admin')
    || channel.startsWith('/categories') || channel.startsWith('categories')
}

function apiKeyAuth(): Record<string, string> {
  return {
    'x-api-key': config.apiKey,
    host: getHost(config.httpEndpoint),
  }
}

function cognitoAuth(token: string): Record<string, string> {
  return {
    Authorization: token,
    host: getHost(config.httpEndpoint),
  }
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

function buildAuthProtocol(): string {
  const headerJson = JSON.stringify(apiKeyAuth())
  return `header-${base64UrlEncode(headerJson)}`
}

function resetKeepalive(timeoutMs: number) {
  if (keepaliveTimer) clearTimeout(keepaliveTimer)
  keepaliveTimer = setTimeout(() => {
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

async function sendSubscribe(id: string, channel: string): Promise<void> {
  // Use Cognito auth for admin channels if available
  let authorization = apiKeyAuth()
  if (isAdminChannel(channel)) {
    const token = await getIdToken()
    if (token) {
      authorization = cognitoAuth(token)
    }
  }

  const msg = JSON.stringify({
    type: 'subscribe',
    id,
    channel,
    authorization,
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
  if (connected && ws?.readyState === WebSocket.OPEN) {
    return Promise.resolve()
  }

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
  const jitter = delay * (0.75 + Math.random() * 0.5)
  reconnectAttempt++
  console.log(`[appsync] reconnecting in ${Math.round(jitter)}ms (attempt ${reconnectAttempt})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect().catch(() => {})
  }, jitter)
}

// ---- public API -----------------------------------------------------------

/**
 * Subscribe to an AppSync Events channel.
 * Uses Cognito auth for admin channels, API_KEY for everything else.
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
 * Uses Cognito auth for admin channels, API_KEY for everything else.
 */
export async function publish(
  channel: string,
  events: unknown[],
): Promise<PublishResponse> {
  const body = JSON.stringify({
    channel,
    events: events.map((e) => JSON.stringify(e)),
  })

  // Build headers — Cognito for admin, API_KEY for everything else
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (isAdminChannel(channel)) {
    const token = await getIdToken()
    if (token) {
      headers['Authorization'] = token
    } else {
      // Fallback to API key if not authenticated
      headers['x-api-key'] = config.apiKey
    }
  } else {
    headers['x-api-key'] = config.apiKey
  }

  const res = await fetch(config.httpEndpoint, {
    method: 'POST',
    headers,
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
    ws.onclose = null
    ws.close()
    ws = null
  }
}
