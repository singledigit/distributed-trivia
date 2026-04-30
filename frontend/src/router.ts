import { createRouter, createWebHistory } from 'vue-router'
import HomeView from './views/HomeView.vue'
import { isAuthenticated } from './auth'

const AdminView = () => import('./views/AdminView.vue')
const CategoriesView = () => import('./views/CategoriesView.vue')
const PlayerView = () => import('./views/PlayerView.vue')
const LeaderboardView = () => import('./views/LeaderboardView.vue')
const NotFoundView = () => import('./views/NotFoundView.vue')

const requireAuth = () => {
  if (!isAuthenticated()) return { name: 'home' }
  return true
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/controller', name: 'admin', component: AdminView, beforeEnter: requireAuth },
    { path: '/categories', name: 'categories', component: CategoriesView, beforeEnter: requireAuth },
    { path: '/play/:sessionId', name: 'player', component: PlayerView },
    { path: '/leaderboard/:sessionId', name: 'leaderboard', component: LeaderboardView },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFoundView },
  ],
})

export default router
