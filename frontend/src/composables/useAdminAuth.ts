import { ref } from 'vue'
import { signIn, completeNewPassword, loadSession } from '../auth'

export type AuthPhase = 'login' | 'new_password' | 'authenticated'

export function useAdminAuth() {
  const authPhase = ref<AuthPhase>('login')
  const loginUsername = ref('')
  const loginPassword = ref('')
  const loginError = ref('')
  const loggingIn = ref(false)
  const newPassword = ref('')
  const newPasswordConfirm = ref('')
  const challengeSession = ref('')
  const adminUsername = ref('')

  async function handleLogin(onAuthenticated: () => Promise<void>) {
    loginError.value = ''
    loggingIn.value = true

    const result = await signIn(loginUsername.value, loginPassword.value)

    if (result.challengeName === 'NEW_PASSWORD_REQUIRED') {
      challengeSession.value = result.challengeSession!
      adminUsername.value = loginUsername.value
      loggingIn.value = false
      authPhase.value = 'new_password'
      return
    }

    if (result.success) {
      adminUsername.value = result.session!.username
      loggingIn.value = false
      authPhase.value = 'authenticated'
      await onAuthenticated()
      return
    }

    loginError.value = result.error ?? 'Sign in failed'
    loggingIn.value = false
  }

  async function handleNewPassword(onAuthenticated: () => Promise<void>) {
    if (newPassword.value !== newPasswordConfirm.value) {
      loginError.value = 'Passwords do not match'
      return
    }
    if (newPassword.value.length < 8) {
      loginError.value = 'Password must be at least 8 characters'
      return
    }

    loginError.value = ''
    loggingIn.value = true

    const result = await completeNewPassword(adminUsername.value, newPassword.value, challengeSession.value)

    if (result.success) {
      loggingIn.value = false
      authPhase.value = 'authenticated'
      await onAuthenticated()
      return
    }

    loginError.value = result.error ?? 'Password change failed'
    loggingIn.value = false
  }

  function loadUsername() {
    adminUsername.value = loadSession()?.username ?? ''
  }

  return {
    authPhase,
    loginUsername,
    loginPassword,
    loginError,
    loggingIn,
    newPassword,
    newPasswordConfirm,
    adminUsername,
    handleLogin,
    handleNewPassword,
    loadUsername,
  }
}
