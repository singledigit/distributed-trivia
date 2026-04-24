<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<template>
  <div class="not-found">
    <div class="not-found-content">
      <div class="big-question">?</div>
      <h1>Lost in the Quiz</h1>
      <p>This page doesn't exist — but the trivia does.</p>
      <RouterLink to="/controller" class="back-link">
        <span class="back-arrow">←</span> Back to Game Controller
      </RouterLink>
    </div>
    <div class="bg-orb bg-orb-1" />
    <div class="bg-orb bg-orb-2" />
  </div>
</template>

<style scoped>
.not-found {
  min-height: 100svh;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
  padding: 24px;
}

.not-found-content {
  text-align: center;
  position: relative;
  z-index: 1;
  animation: slide-up 0.5s ease-out;
}

.big-question {
  font-family: var(--font-display);
  font-size: 160px;
  font-weight: 900;
  line-height: 1;
  background: linear-gradient(135deg, var(--gold), var(--rose));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter: drop-shadow(0 0 40px var(--gold-glow));
  margin-bottom: 16px;
}

h1 {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 8px;
}

p {
  color: var(--text-secondary);
  font-size: 16px;
  margin-bottom: 32px;
}

.back-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 28px;
  background: var(--bg-card);
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-full);
  color: var(--gold-light);
  font-weight: 600;
  font-size: 15px;
  transition: all 0.2s;
}

.back-link:hover {
  background: var(--bg-elevated);
  border-color: var(--gold);
  box-shadow: var(--shadow-glow-gold);
  color: var(--gold-light);
}

.back-arrow {
  font-size: 18px;
  transition: transform 0.2s;
}

.back-link:hover .back-arrow {
  transform: translateX(-3px);
}

.bg-orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(100px);
  pointer-events: none;
}

.bg-orb-1 {
  width: 400px;
  height: 400px;
  background: var(--gold);
  opacity: 0.06;
  top: -100px;
  right: -100px;
}

.bg-orb-2 {
  width: 300px;
  height: 300px;
  background: var(--cyan);
  opacity: 0.05;
  bottom: -80px;
  left: -80px;
}
</style>