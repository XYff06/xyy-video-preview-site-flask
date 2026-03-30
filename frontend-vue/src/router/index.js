import { createRouter, createWebHistory } from 'vue-router';

import HomeView from '../views/HomeView.vue';
import DetailView from '../views/DetailView.vue';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView
    },
    {
      path: '/series/:titleName(.*)',
      name: 'detail',
      component: DetailView,
      props: true
    }
  ],
  scrollBehavior() {
    return { top: 0 };
  }
});

export default router;
