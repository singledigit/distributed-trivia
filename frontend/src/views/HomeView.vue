<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<template>
  <div class="home">
    <div class="bg-grid" />
    <div class="bg-orb bg-orb-1" />
    <div class="bg-orb bg-orb-2" />
    <div class="bg-orb bg-orb-3" />

    <div class="home-inner">
      <!-- Hero -->
      <div class="hero">
        <div class="hero-icon">?</div>
        <h1 class="hero-title">Trivia Night</h1>
        <p class="hero-sub">
          Real-time multiplayer trivia. A host runs the show, players compete on their phones, and the leaderboard lights up on the big screen.
        </p>
      </div>

      <!-- How it works -->
      <div class="steps">
        <div class="step">
          <div class="step-num">1</div>
          <div class="step-content">
            <h3>Host creates a game</h3>
            <p>Pick a category, set the mode, and launch a session from the controller.</p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div class="step-content">
            <h3>Players scan to join</h3>
            <p>A QR code and link let anyone jump in from their phone — no app needed.</p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div class="step-content">
            <h3>Compete in real time</h3>
            <p>Answer questions, rack up points, and watch the leaderboard shuffle live.</p>
          </div>
        </div>
      </div>

      <!-- CTA -->
      <div class="cta">
        <RouterLink to="/controller" class="btn btn-gold btn-lg">
          Start Hosting
        </RouterLink>
      </div>

      <!-- Footer note -->
      <p class="footer-note">
        Players join via a link from the host. If you have a game link, open it directly.
      </p>
    </div>
  </div>
</template>

<style scoped>
.home {
  min-height: 100svh;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
  padding: 40px 24px;
}

.home-inner {
  position: relative;
  z-index: 1;
  max-width: 560px;
  width: 100%;
}

/* ---- Ambient ---- */

.bg-grid {
  position: fixed;
  inset: 0;
  background-image:
    linear-gradient(var(--border-subtle) 1px, transparent 1px),
    linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px);
  background-size: 60px 60px;
  opacity: 0.35;
  pointer-events: none;
}

.bg-orb {
  position: fixed;
  border-radius: 50%;
  filter: blur(120px);
  pointer-events: none;
}

.bg-orb-1 {
  width: 500px;
  height: 500px;
  background: var(--gold);
  opacity: 0.05;
  top: -180px;
  right: -120px;
}

.bg-orb-2 {
  width: 400px;
  height: 400px;
  background: var(--cyan);
  opacity: 0.04;
  bottom: -120px;
  left: -100px;
}

.bg-orb-3 {
  width: 250px;
  height: 250px;
  background: var(--violet);
  opacity: 0.04;
  top: 50%;
  left: -60px;
}

/* ---- Hero ---- */

.hero {
  text-align: center;
  margin-bottom: 48px;
  animation: slide-up 0.5s ease-out;
}

.hero-icon {
  width: 72px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 20px;
  background: linear-gradient(135deg, var(--gold), #ef4444);
  border-radius: var(--radius-xl);
  font-family: Georgia, serif;
  font-size: 36px;
  font-weight: bold;
  color: #fff;
  box-shadow: var(--shadow-glow-gold);
}

.hero-title {
  font-size: 44px;
  font-weight: 900;
  letter-spacing: -0.5px;
  margin-bottom: 12px;
  background: linear-gradient(135deg, var(--text-primary), var(--gold-light));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.hero-sub {
  font-size: 17px;
  line-height: 1.6;
  color: var(--text-secondary);
  max-width: 440px;
  margin: 0 auto;
}

/* ---- Steps ---- */

.steps {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 40px;
  animation: slide-up 0.5s ease-out 0.1s both;
}

.step {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 18px 20px;
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  transition: border-color 0.2s;
}

.step:hover {
  border-color: var(--border-medium);
}

.step-num {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  background: var(--gold-subtle);
  border: 1px solid rgba(245, 158, 11, 0.2);
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 700;
  color: var(--gold-light);
}

.step-content h3 {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.step-content p {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.45;
}

/* ---- CTA ---- */

.cta {
  text-align: center;
  margin-bottom: 24px;
  animation: slide-up 0.5s ease-out 0.2s both;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: none;
  border-radius: var(--radius-md);
  font-family: var(--font-display);
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  text-decoration: none;
}

.btn-gold {
  background: linear-gradient(135deg, var(--gold), #d97706);
  color: #0c0a1a;
  box-shadow: 0 2px 12px var(--gold-glow);
}

.btn-gold:hover {
  box-shadow: var(--shadow-glow-gold);
  transform: translateY(-1px);
  color: #0c0a1a;
}

.btn-lg {
  padding: 16px 40px;
  font-size: 17px;
  border-radius: var(--radius-md);
}

/* ---- Footer ---- */

.footer-note {
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
  animation: slide-up 0.5s ease-out 0.3s both;
}

/* ---- Responsive ---- */

@media (max-width: 480px) {
  .hero-title { font-size: 34px; }
  .hero-sub { font-size: 15px; }
  .hero-icon { width: 60px; height: 60px; font-size: 30px; }
}
</style>