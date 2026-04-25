<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { signOut } from '../auth'

defineProps<{
  activePage: 'game' | 'categories'
  showNav: boolean
}>()

function handleSignOut() {
  signOut()
  window.location.href = '/controller'
}
</script>

<template>
  <header class="header">
    <div class="logo">
      <span class="logo-icon">?</span>
      <span class="logo-text">Trivia Night</span>
    </div>
    <nav v-if="showNav" class="nav">
      <RouterLink to="/controller" :class="['nav-link', { 'nav-active': activePage === 'game' }]">Game</RouterLink>
      <RouterLink to="/categories" :class="['nav-link', { 'nav-active': activePage === 'categories' }]">Categories</RouterLink>
    </nav>
    <button v-if="showNav" class="btn-signout" @click="handleSignOut">Sign Out</button>
  </header>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 32px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border-subtle);
}

.logo { display: flex; align-items: center; gap: 10px; }

.logo-icon {
  width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, var(--gold), #ef4444);
  border-radius: var(--radius-sm);
  font-family: Georgia, serif; font-size: 20px; font-weight: bold; color: #fff;
}

.logo-text {
  font-family: var(--font-display); font-size: 18px; font-weight: 700;
}

.nav { display: flex; gap: 4px; margin-left: auto; }

.nav-link {
  padding: 6px 14px;
  border-radius: var(--radius-full);
  font-size: 13px; font-weight: 500;
  color: var(--text-muted);
  text-decoration: none;
  transition: all 0.2s;
}

.nav-link:hover { color: var(--text-secondary); background: var(--bg-card); }

.nav-active {
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
}

.btn-signout {
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  color: var(--text-muted);
  font-family: var(--font-display);
  font-size: 12px;
  padding: 4px 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-signout:hover {
  border-color: var(--border-medium);
  color: var(--text-secondary);
}
</style>
