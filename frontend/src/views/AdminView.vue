<script setup lang="ts">
import { onMounted } from 'vue'
import { isAuthenticated } from '../auth'
import { useAdminAuth } from '../composables/useAdminAuth'
import { useAdminSession } from '../composables/useAdminSession'
import AppHeader from '../components/AppHeader.vue'

// ---------------------------------------------------------------------------
// Composables
// ---------------------------------------------------------------------------

const auth = useAdminAuth()
const session = useAdminSession()

// Expose auth state to template
const { loginUsername, loginPassword, loginError, loggingIn, newPassword, newPasswordConfirm } = auth

// Expose session state to template
const {
  phase, sessionId, qrCodeDataUrl, sessionUrl, players, categories,
  selectedCategoryId, mode, timeLimitMinutes, questionCount, creating,
  createError, countdown, canStart, sortedPlayers, playerCount, completedCount,
  createSession, startGame, cancelGame, newGame, copyUrl,
} = session

// Auth phase drives login/new_password views
const authPhase = auth.authPhase

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function onAuthenticated() {
  auth.loadUsername()
  await session.initialize()
}

async function handleLogin() {
  await auth.handleLogin(onAuthenticated)
}

async function handleNewPassword() {
  await auth.handleNewPassword(onAuthenticated)
}

onMounted(async () => {
  if (isAuthenticated()) {
    auth.authPhase.value = 'authenticated'
    await onAuthenticated()
  }
})
</script>

<template>
  <div class="admin">
    <!-- Ambient background -->
    <div class="bg-grid" />
    <div class="bg-orb bg-orb-gold" />
    <div class="bg-orb bg-orb-cyan" />

    <div class="admin-inner">
      <AppHeader active-page="game" :show-nav="authPhase === 'authenticated'" />

      <!-- LOGIN -->
      <div v-if="authPhase === 'login'" class="phase-login">
        <div class="setup-hero">
          <h1 class="setup-title">Host Login</h1>
          <p class="setup-sub">Sign in to create and manage trivia games.</p>
        </div>
        <div class="card">
          <form class="login-form" @submit.prevent="handleLogin">
            <div class="field">
              <label for="username">Email</label>
              <input id="username" v-model="loginUsername" type="email" class="input" autocomplete="username" placeholder="you@example.com" />
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" v-model="loginPassword" type="password" class="input" autocomplete="current-password" />
            </div>
            <button type="submit" class="btn btn-gold btn-full" :disabled="loggingIn || !loginUsername || !loginPassword">
              <span v-if="loggingIn" class="spinner" />
              {{ loggingIn ? 'Signing in…' : 'Sign In' }}
            </button>
            <p v-if="loginError" class="error-msg">{{ loginError }}</p>
          </form>
        </div>
      </div>

      <!-- NEW PASSWORD -->
      <div v-if="authPhase === 'new_password'" class="phase-login">
        <div class="setup-hero">
          <h1 class="setup-title">Set New Password</h1>
          <p class="setup-sub">Your temporary password needs to be changed.</p>
        </div>
        <div class="card">
          <form class="login-form" @submit.prevent="handleNewPassword">
            <div class="field">
              <label for="newPw">New Password</label>
              <input id="newPw" v-model="newPassword" type="password" class="input" autocomplete="new-password" />
            </div>
            <div class="field">
              <label for="confirmPw">Confirm Password</label>
              <input id="confirmPw" v-model="newPasswordConfirm" type="password" class="input" autocomplete="new-password" />
            </div>
            <button type="submit" class="btn btn-gold btn-full" :disabled="loggingIn || !newPassword || !newPasswordConfirm">
              <span v-if="loggingIn" class="spinner" />
              {{ loggingIn ? 'Updating…' : 'Set Password' }}
            </button>
            <p v-if="loginError" class="error-msg">{{ loginError }}</p>
          </form>
        </div>
      </div>

      <!-- LOADING -->
      <div v-if="phase === 'loading'" class="phase-center">
        <div class="loader" />
        <p class="phase-msg">Connecting…</p>
      </div>

      <!-- SETUP -->
      <div v-if="phase === 'setup'" class="phase-setup">
        <div class="setup-hero">
          <h1 class="setup-title">New Game</h1>
          <p class="setup-sub">Configure your trivia session and invite players.</p>
        </div>

        <div class="card">
          <div class="field">
            <label for="category">Category</label>
            <div class="select-wrap">
              <select id="category" v-model="selectedCategoryId">
                <option v-if="categories.length === 0" value="" disabled>Loading…</option>
                <option v-for="cat in categories" :key="cat.categoryId" :value="cat.categoryId">
                  {{ cat.categoryName }}
                </option>
              </select>
              <span class="select-arrow">▾</span>
            </div>
          </div>

          <div class="field">
            <label>Game Mode</label>
            <div class="toggle-row">
              <button :class="['toggle-btn', { active: mode === 'timed' }]" @click="mode = 'timed'">
                <span class="toggle-icon">⏱</span> Timed
              </button>
              <button :class="['toggle-btn', { active: mode === 'question_count' }]" @click="mode = 'question_count'">
                <span class="toggle-icon">#</span> Question Count
              </button>
            </div>
          </div>

          <div v-if="mode === 'timed'" class="field">
            <label for="timeLimit">Time Limit</label>
            <div class="stepper">
              <button class="stepper-btn" @click="timeLimitMinutes = Math.max(1, timeLimitMinutes - 1)">−</button>
              <span class="stepper-value">{{ timeLimitMinutes }} min</span>
              <button class="stepper-btn" @click="timeLimitMinutes = Math.min(5, timeLimitMinutes + 1)">+</button>
            </div>
          </div>

          <div v-if="mode === 'question_count'" class="field">
            <label for="questionCount">Questions</label>
            <div class="stepper">
              <button class="stepper-btn" @click="questionCount = Math.max(1, questionCount - 1)">−</button>
              <span class="stepper-value">{{ questionCount }}</span>
              <button class="stepper-btn" @click="questionCount = Math.min(30, questionCount + 1)">+</button>
            </div>
          </div>

          <button class="btn btn-gold btn-full" :disabled="creating || !selectedCategoryId" @click="createSession">
            <span v-if="creating" class="spinner" />
            {{ creating ? 'Creating…' : 'Create Session' }}
          </button>
          <p v-if="createError" class="error-msg">{{ createError }}</p>
        </div>
      </div>

      <!-- LOBBY -->
      <div v-if="phase === 'lobby'" class="phase-lobby">
        <div class="lobby-top">
          <h1 class="section-title">Lobby</h1>
          <span class="mono-badge">{{ sessionId.slice(0, 8) }}</span>
        </div>

        <div class="lobby-grid">
          <div class="card qr-card">
            <p class="card-label">Scan to Join</p>
            <div class="qr-frame">
              <img v-if="qrCodeDataUrl" :src="qrCodeDataUrl" alt="QR code to join game" class="qr-img" />
            </div>
            <div class="qr-url">
              <a :href="sessionUrl" target="_blank" rel="noopener">{{ sessionUrl }}</a>
            </div>
            <button class="btn btn-ghost btn-sm" @click="copyUrl">Copy Link</button>
          </div>

          <div class="card players-card">
            <div class="card-header">
              <p class="card-label">Players</p>
              <span class="count-pill">{{ playerCount }}</span>
            </div>
            <div v-if="players.length === 0" class="empty-players">
              <div class="empty-pulse" />
              <p>Waiting for players…</p>
            </div>
            <ul v-else class="player-list">
              <li v-for="(p, i) in players" :key="p.participantId" class="player-item" :style="{ animationDelay: i * 60 + 'ms' }">
                <span class="player-avatar">{{ p.displayName.charAt(0).toUpperCase() }}</span>
                <span class="player-name">{{ p.displayName }}</span>
              </li>
            </ul>
          </div>
        </div>

        <div class="lobby-actions">
          <button class="btn btn-gold btn-lg" :disabled="!canStart" @click="startGame">Start Game</button>
          <a :href="`/leaderboard/${sessionId}`" target="_blank" class="btn btn-ghost">Open Leaderboard ↗</a>
          <button class="btn btn-ghost-danger" @click="cancelGame">Cancel</button>
        </div>
      </div>

      <!-- PLAYING -->
      <div v-if="phase === 'playing'" class="phase-playing">
        <div class="playing-header">
          <h1 class="section-title">Live Game</h1>
          <div v-if="countdown > 0" class="countdown-chip">
            Starting in <span class="countdown-num">{{ countdown }}</span>
          </div>
          <div v-else class="live-chip">
            <span class="live-dot" /> LIVE
          </div>
        </div>

        <div class="stats-row">
          <div class="stat-card">
            <span class="stat-num">{{ playerCount }}</span>
            <span class="stat-label">Players</span>
          </div>
          <div class="stat-card">
            <span class="stat-num">{{ completedCount }}</span>
            <span class="stat-label">Finished</span>
          </div>
        </div>

        <div class="card">
          <p class="card-label">Leaderboard</p>
          <table v-if="sortedPlayers.length > 0" class="lb-table">
            <thead>
              <tr>
                <th class="col-rank">#</th>
                <th>Player</th>
                <th class="col-q">Q</th>
                <th class="col-score">Score</th>
                <th class="col-status"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in sortedPlayers" :key="p.participantId" :class="{ 'row-first': i === 0 }">
                <td class="col-rank rank-num">{{ i + 1 }}</td>
                <td class="player-cell">{{ p.displayName }}</td>
                <td class="col-q mono">{{ p.currentQuestion }}</td>
                <td class="col-score mono score-val">{{ p.score }}</td>
                <td class="col-status">
                  <span :class="['dot', `dot-${p.statusDot}`]" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="center-actions">
          <a :href="`/leaderboard/${sessionId}`" target="_blank" class="btn btn-ghost">Open Leaderboard ↗</a>
          <button class="btn btn-ghost-danger" @click="cancelGame">End Game</button>
        </div>
      </div>

      <!-- FINISHED -->
      <div v-if="phase === 'finished'" class="phase-finished">
        <div class="trophy-icon">🏆</div>
        <h1 class="section-title">Game Over</h1>

        <div class="card">
          <table v-if="sortedPlayers.length > 0" class="lb-table">
            <thead>
              <tr>
                <th class="col-rank">Rank</th>
                <th>Player</th>
                <th class="col-q">Questions</th>
                <th class="col-score">Score</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in sortedPlayers" :key="p.participantId" :class="{ 'row-first': i === 0 }">
                <td class="col-rank">
                  <span v-if="i === 0" class="medal">🥇</span>
                  <span v-else-if="i === 1" class="medal">🥈</span>
                  <span v-else-if="i === 2" class="medal">🥉</span>
                  <span v-else class="rank-num">{{ i + 1 }}</span>
                </td>
                <td class="player-cell">{{ p.displayName }}</td>
                <td class="col-q mono">{{ p.currentQuestion }}</td>
                <td class="col-score mono score-val">{{ p.score }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="center-actions">
          <button class="btn btn-gold btn-lg" @click="newGame">New Game</button>
        </div>
      </div>

      <!-- CANCELLED -->
      <div v-if="phase === 'cancelled'" class="phase-cancelled">
        <div class="cancel-icon">✕</div>
        <h1 class="section-title">Cancelled</h1>
        <p class="phase-msg">The session was cancelled.</p>
        <div class="center-actions">
          <button class="btn btn-gold btn-lg" @click="newGame">New Game</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ============================================================
   ADMIN VIEW — Host Control Panel
   ============================================================ */

.admin {
  min-height: 100svh;
  position: relative;
  overflow: hidden;
}

.admin-inner {
  position: relative;
  z-index: 1;
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 20px 60px;
}

/* ---- Ambient background ---- */

.bg-grid {
  position: fixed;
  inset: 0;
  background-image:
    linear-gradient(var(--border-subtle) 1px, transparent 1px),
    linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px);
  background-size: 60px 60px;
  opacity: 0.4;
  pointer-events: none;
}

.bg-orb {
  position: fixed;
  border-radius: 50%;
  filter: blur(120px);
  pointer-events: none;
}

.bg-orb-gold {
  width: 500px;
  height: 500px;
  background: var(--gold);
  opacity: 0.04;
  top: -200px;
  right: -150px;
}

.bg-orb-cyan {
  width: 400px;
  height: 400px;
  background: var(--cyan);
  opacity: 0.03;
  bottom: -150px;
  left: -100px;
}

/* ---- Loading ---- */

.phase-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 50vh;
  gap: 16px;
}

.loader {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-medium);
  border-top-color: var(--gold);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

.phase-msg {
  color: var(--text-secondary);
  font-size: 15px;
}

/* ---- Setup ---- */

.phase-setup {
  animation: slide-up 0.4s ease-out;
}

.setup-hero {
  text-align: center;
  margin-bottom: 32px;
}

.setup-title {
  font-size: 36px;
  font-weight: 800;
  background: linear-gradient(135deg, var(--gold-light), var(--gold), #ef4444);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin-bottom: 8px;
}

.setup-sub {
  color: var(--text-secondary);
  font-size: 15px;
}

/* ---- Card ---- */

/* Card base → style.css */

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* ---- Form fields ---- */

.field {
  margin-bottom: 24px;
}

.field label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.select-wrap {
  position: relative;
}

.select-wrap select {
  width: 100%;
  padding: 12px 40px 12px 16px;
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 15px;
  appearance: none;
  cursor: pointer;
  transition: border-color 0.2s;
}

.select-wrap select:focus {
  outline: none;
  border-color: var(--gold);
  box-shadow: 0 0 0 3px var(--gold-glow);
}

.select-arrow {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  pointer-events: none;
  font-size: 14px;
}

/* ---- Toggle buttons ---- */

.toggle-row {
  display: flex;
  gap: 8px;
}

.toggle-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.toggle-btn:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.toggle-btn.active {
  background: var(--gold-subtle);
  border-color: var(--gold);
  color: var(--gold-light);
  box-shadow: 0 0 0 3px var(--gold-glow);
}

.toggle-icon {
  font-size: 16px;
}

/* ---- Stepper ---- */

.stepper {
  display: inline-flex;
  align-items: center;
  gap: 0;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-input);
}

.stepper-btn {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 18px;
  cursor: pointer;
  transition: all 0.15s;
}

.stepper-btn:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.stepper-value {
  min-width: 80px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
  border-inline: 1px solid var(--border-subtle);
  padding: 0 8px;
}

/* Buttons, spinner, error-msg, card, card-label, card-hint → style.css */

/* ---- Lobby ---- */

.phase-lobby {
  animation: slide-up 0.4s ease-out;
}

.lobby-top {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}

.section-title {
  font-size: 28px;
  font-weight: 800;
}

.mono-badge {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  padding: 4px 10px;
  border-radius: var(--radius-full);
}

.lobby-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 24px;
}

@media (max-width: 600px) {
  .lobby-grid { grid-template-columns: 1fr; }
}

.qr-card {
  text-align: center;
}

.qr-frame {
  width: 200px;
  height: 200px;
  margin: 0 auto 12px;
  border: 2px solid var(--border-medium);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-input);
}

.qr-img {
  width: 180px;
  height: 180px;
}

.qr-url {
  font-size: 12px;
  margin-bottom: 12px;
  word-break: break-all;
}

.qr-url a {
  color: var(--cyan-light);
}

.players-card {
  display: flex;
  flex-direction: column;
}

.count-pill {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--gold-light);
  background: var(--gold-subtle);
  padding: 2px 10px;
  border-radius: var(--radius-full);
}

.empty-players {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-muted);
  font-size: 14px;
}

.empty-pulse {
  width: 10px;
  height: 10px;
  background: var(--gold);
  border-radius: 50%;
  animation: pulse-glow 1.5s ease-in-out infinite;
}

.player-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 280px;
  overflow-y: auto;
}

.player-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  animation: slide-up 0.3s ease-out both;
}

.player-avatar {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--violet), var(--cyan));
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  flex-shrink: 0;
}

.player-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.lobby-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  align-items: center;
}

/* ---- Playing ---- */

.phase-playing {
  animation: slide-up 0.4s ease-out;
}

.playing-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}

.countdown-chip {
  font-size: 14px;
  color: var(--gold-light);
  background: var(--gold-subtle);
  border: 1px solid rgba(245, 158, 11, 0.3);
  padding: 6px 16px;
  border-radius: var(--radius-full);
}

.countdown-num {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 18px;
}

.live-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--rose);
  background: rgba(244, 63, 94, 0.08);
  border: 1px solid rgba(244, 63, 94, 0.3);
  padding: 6px 16px;
  border-radius: var(--radius-full);
}

.live-dot {
  width: 8px;
  height: 8px;
  background: var(--rose);
  border-radius: 50%;
  animation: pulse-glow 1s ease-in-out infinite;
}

.stats-row {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}

.stat-card {
  flex: 1;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 16px;
  text-align: center;
}

.stat-num {
  display: block;
  font-family: var(--font-mono);
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
}

.stat-label {
  font-size: 12px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* ---- Leaderboard table ---- */

.lb-table {
  width: 100%;
  border-collapse: collapse;
}

.lb-table th {
  text-align: left;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-subtle);
}

.lb-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 14px;
  color: var(--text-primary);
}

.lb-table tr:last-child td {
  border-bottom: none;
}

.col-rank { width: 50px; text-align: center; }
.col-q { width: 60px; text-align: center; }
.col-score { width: 80px; text-align: right; }
.col-status { width: 40px; text-align: center; }

.rank-num {
  font-family: var(--font-mono);
  font-weight: 700;
  color: var(--text-muted);
}

.row-first td {
  background: var(--gold-subtle);
}

.row-first .rank-num {
  color: var(--gold-light);
}

.mono {
  font-family: var(--font-mono);
}

.score-val {
  font-weight: 700;
  color: var(--emerald);
}

.player-cell {
  font-weight: 500;
}

.medal {
  font-size: 18px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.dot-green { background: var(--emerald); box-shadow: 0 0 6px var(--emerald-glow); }
.dot-amber { background: var(--gold); box-shadow: 0 0 6px var(--gold-glow); }
.dot-red { background: var(--rose); box-shadow: 0 0 6px var(--rose-glow); }
.dot-checkmark { background: var(--emerald); box-shadow: 0 0 6px var(--emerald-glow); }

.center-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-top: 24px;
}

/* ---- Finished / Cancelled ---- */

.phase-finished, .phase-cancelled {
  text-align: center;
  animation: slide-up 0.4s ease-out;
}

.trophy-icon {
  font-size: 64px;
  margin-bottom: 8px;
  animation: float 3s ease-in-out infinite;
}

.cancel-icon {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 12px;
  border-radius: 50%;
  background: rgba(244, 63, 94, 0.1);
  border: 2px solid rgba(244, 63, 94, 0.3);
  color: var(--rose);
  font-size: 24px;
  font-weight: 700;
}

.phase-finished .card, .phase-cancelled .card {
  text-align: left;
  margin-top: 24px;
}

/* ---- Login ---- */

.phase-login {
  animation: slide-up 0.4s ease-out;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.login-form .field:last-of-type {
  margin-bottom: 20px;
}

.input {
  width: 100%;
  padding: 12px 16px;
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 15px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
  box-sizing: border-box;
}

.input:focus {
  border-color: var(--gold);
  box-shadow: 0 0 0 3px var(--gold-glow);
}

/* ---- Create Category ---- */

/* card-hint → style.css */

.create-cat-row {
  display: flex;
  gap: 8px;
}

.cat-input {
  flex: 1;
  padding: 10px 14px;
  background: var(--bg-input);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
  box-sizing: border-box;
}

.cat-input:focus {
  border-color: var(--gold);
  box-shadow: 0 0 0 3px var(--gold-glow);
}

.cat-input::placeholder {
  color: var(--text-muted);
}

.btn-cat {
  white-space: nowrap;
  padding: 10px 18px;
  font-size: 13px;
}

.spinner-sm {
  width: 14px;
  height: 14px;
  border-width: 2px;
}

.cat-status {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
}

.cat-status-generating {
  background: var(--gold-subtle);
  border: 1px solid rgba(245, 158, 11, 0.2);
  color: var(--gold-light);
}

.cat-status-created {
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.2);
  color: var(--emerald);
}

.cat-status-error {
  background: rgba(244, 63, 94, 0.06);
  border: 1px solid rgba(244, 63, 94, 0.2);
  color: var(--rose);
}

.cat-status-icon {
  flex-shrink: 0;
}

.cat-status-text {
  line-height: 1.4;
}
</style>