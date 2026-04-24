import { createRouter, createWebHistory } from 'vue-router'
import AdminView from './views/AdminView.vue'
import PlayerView from './views/PlayerView.vue'
import LeaderboardView from './views/LeaderboardView.vue'
import NotFoundView from './views/NotFoundView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/controller', name: 'admin', component: AdminView },
    { path: '/play/:sessionId', name: 'player', component: PlayerView },
    { path: '/leaderboard/:sessionId', name: 'leaderboard', component: LeaderboardView },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFoundView },
  ],
})

export default router
