import { createRouter, createWebHistory } from 'vue-router'
import HomeView from './views/HomeView.vue'
import AdminView from './views/AdminView.vue'
import CategoriesView from './views/CategoriesView.vue'
import PlayerView from './views/PlayerView.vue'
import LeaderboardView from './views/LeaderboardView.vue'
import NotFoundView from './views/NotFoundView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/controller', name: 'admin', component: AdminView },
    { path: '/categories', name: 'categories', component: CategoriesView },
    { path: '/play/:sessionId', name: 'player', component: PlayerView },
    { path: '/leaderboard/:sessionId', name: 'leaderboard', component: LeaderboardView },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFoundView },
  ],
})

export default router
