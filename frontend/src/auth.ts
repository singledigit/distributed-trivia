/**
 * Lightweight Cognito auth module — zero SDK dependencies.
 *
 * Uses the Cognito Identity Provider REST API directly via fetch.
 * Handles sign-in, token refresh, new-password challenge, and session persistence.
 */

const REGION = import.meta.env.VITE_AWS_REGION as string ?? 'us-west-2'
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID as string
const COGNITO_ENDPOINT = `https://cognito-idp.${REGION}.amazonaws.com/`

const STORAGE_KEY = 'trivia_admin_auth'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthSession {
  idToken: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  username: string
}

export interface AuthResult {
  success: boolean
  session?: AuthSession
  challengeName?: string
  challengeSession?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Cognito REST API helper
// ---------------------------------------------------------------------------

async function cognitoRequest(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(COGNITO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(payload),
  })

  const data = await res.json() as Record<string, unknown>

  if (!res.ok) {
    const errorType = (data.__type as string)?.split('#').pop() ?? 'UnknownError'
    const message = (data.message as string) ?? (data.Message as string) ?? 'Request failed'
    throw new Error(`${errorType}: ${message}`)
  }

  return data
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

export async function signIn(username: string, password: string): Promise<AuthResult> {
  try {
    const data = await cognitoRequest('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
      },
    })

    if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
      return {
        success: false,
        challengeName: 'NEW_PASSWORD_REQUIRED',
        challengeSession: data.Session as string,
      }
    }

    const auth = data.AuthenticationResult as Record<string, unknown>
    if (auth) {
      const session = buildSession(username, auth)
      saveSession(session)
      return { success: true, session }
    }

    return { success: false, error: 'Unexpected auth response' }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Sign in failed'
    return { success: false, error: message }
  }
}

// ---------------------------------------------------------------------------
// Complete new password challenge
// ---------------------------------------------------------------------------

export async function completeNewPassword(
  username: string,
  newPassword: string,
  challengeSession: string,
): Promise<AuthResult> {
  try {
    const data = await cognitoRequest('RespondToAuthChallenge', {
      ClientId: CLIENT_ID,
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: challengeSession,
      ChallengeResponses: {
        USERNAME: username,
        NEW_PASSWORD: newPassword,
      },
    })

    const auth = data.AuthenticationResult as Record<string, unknown>
    if (auth) {
      const session = buildSession(username, auth)
      saveSession(session)
      return { success: true, session }
    }

    return { success: false, error: 'Unexpected challenge response' }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Password change failed'
    return { success: false, error: message }
  }
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

export async function refreshSession(): Promise<AuthSession | null> {
  const session = loadSession()
  if (!session?.refreshToken) return null

  try {
    const data = await cognitoRequest('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: {
        REFRESH_TOKEN: session.refreshToken,
      },
    })

    const auth = data.AuthenticationResult as Record<string, unknown>
    if (auth) {
      const refreshed: AuthSession = {
        idToken: auth.IdToken as string,
        accessToken: auth.AccessToken as string,
        refreshToken: session.refreshToken,
        expiresAt: Date.now() + ((auth.ExpiresIn as number) ?? 3600) * 1000,
        username: session.username,
      }
      saveSession(refreshed)
      return refreshed
    }
  } catch {
    clearSession()
  }

  return null
}

// ---------------------------------------------------------------------------
// Get current valid token (auto-refreshes if needed)
// ---------------------------------------------------------------------------

export async function getIdToken(): Promise<string | null> {
  let session = loadSession()
  if (!session) return null

  if (session.expiresAt - Date.now() < 5 * 60 * 1000) {
    session = await refreshSession()
  }

  return session?.idToken ?? null
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

function buildSession(username: string, auth: Record<string, unknown>): AuthSession {
  return {
    idToken: auth.IdToken as string,
    accessToken: auth.AccessToken as string,
    refreshToken: auth.RefreshToken as string,
    expiresAt: Date.now() + ((auth.ExpiresIn as number) ?? 3600) * 1000,
    username,
  }
}

export function loadSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as AuthSession
  } catch {
    return null
  }
}

function saveSession(session: AuthSession) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

export function clearSession() {
  localStorage.removeItem(STORAGE_KEY)
}

export function signOut() {
  clearSession()
}

export function isAuthenticated(): boolean {
  const session = loadSession()
  return !!session && session.expiresAt > Date.now()
}
