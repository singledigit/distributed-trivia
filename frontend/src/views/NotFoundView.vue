<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<template>
  <div class="not-found-view">
    <h1>Page Not Found</h1>
    <p>The page you're looking for doesn't exist.</p>
    <RouterLink to="/controller">Go to Game Controller</RouterLink>
  </div>
</template>
