/**
 * REST API client for synchronous operations.
 *
 * Uses the HTTP API Gateway for request/response patterns.
 * WebSocket (AppSync Events) remains for real-time push updates.
 */

import { getIdToken } from './auth'

const API_ENDPOINT = import.meta.env.VITE_API_ENDPOINT as string

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Category {
  categoryId: string
  categoryName: string
  categoryEmoji: string
  questionCount: number
}

export interface SessionSnapshot {
  sessionId: string
  categoryId: string
  categoryName: string
  categoryEmoji: string
  categoryColor: string
  mode: string
  questionCount: number
  timeLimitMinutes: number
  status: string
  createdAt: string
  gameStartTime: string
  players: LeaderboardPlayer[]
}

export interface LeaderboardPlayer {
  participantId: string
  displayName: string
  status: string
  score: number
  currentQuestion: number
  statusDot: 'green' | 'amber' | 'red' | 'checkmark'
}

export interface CreateSessionParams {
  categoryId: string
  mode: 'timed' | 'question_count'
  questionCount?: number
  timeLimitMinutes?: number
  sessionId?: string
}

export interface JoinResult {
  sessionId: string
  participantId: string
  displayName: string
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/** List all categories (requires admin auth). */
export async function listCategories(): Promise<Category[]> {
  const res = await authFetch('GET', '/api/categories')
  const data = await res.json()
  return data.categories
}

/** Create a new game session (requires admin auth). Returns the sessionId. */
export async function createSession(params: CreateSessionParams): Promise<string> {
  const res = await authFetch('POST', '/api/sessions', params)
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error || 'Failed to create session')
  }
  const data = await res.json()
  return data.sessionId
}

/** Get session snapshot/leaderboard (public, no auth required). */
export async function getSession(sessionId: string): Promise<SessionSnapshot> {
  const res = await publicFetch('GET', `/api/sessions/${sessionId}`)
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error || 'Failed to get session')
  }
  return res.json()
}

/** Start a game session (requires admin auth). */
export async function startSession(sessionId: string): Promise<void> {
  const res = await authFetch('POST', `/api/sessions/${sessionId}/start`)
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error || 'Failed to start session')
  }
}

/** Cancel a game session (requires admin auth). */
export async function cancelSession(sessionId: string): Promise<void> {
  const res = await authFetch('POST', `/api/sessions/${sessionId}/cancel`)
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error || 'Failed to cancel session')
  }
}

/** Join a game session (public, no auth required). */
export async function joinSession(sessionId: string, displayName: string, participantId?: string): Promise<JoinResult> {
  const body: Record<string, string> = { displayName }
  if (participantId) body.participantId = participantId
  const res = await publicFetch('POST', `/api/sessions/${sessionId}/join`, body)
  if (!res.ok) {
    const data = await res.json()
    throw new Error(data.error || 'Failed to join session')
  }
  return res.json()
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function authFetch(method: string, path: string, body?: unknown): Promise<Response> {
  const token = await getIdToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  return fetch(`${API_ENDPOINT}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function publicFetch(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${API_ENDPOINT}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}
