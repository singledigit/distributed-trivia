import { createRouter, createWebHistory } from 'vue-router'
import HomeView from './views/HomeView.vue'

const AdminView = () => import('./views/AdminView.vue')
const CategoriesView = () => import('./views/CategoriesView.vue')
const PlayerView = () => import('./views/PlayerView.vue')
const LeaderboardView = () => import('./views/LeaderboardView.vue')
const NotFoundView = () => import('./views/NotFoundView.vue')

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
