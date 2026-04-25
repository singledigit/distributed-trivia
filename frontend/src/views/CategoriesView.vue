<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { subscribe, publish } from '../appsync-events'
import { isAuthenticated } from '../auth'
import AppHeader from '../components/AppHeader.vue'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Category {
  categoryId: string
  categoryName: string
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const authenticated = ref(false)
const categories = ref<Category[]>([])
const loading = ref(true)
const newCategoryName = ref('')
const creatingCategory = ref(false)
const categoryStatus = ref<{ type: 'generating' | 'created' | 'error'; name: string; message: string } | null>(null)

// Rename
const renamingId = ref<string | null>(null)
const renameValue = ref('')

// Delete
const deletingId = ref<string | null>(null)

const unsubscribers: Array<() => void> = []

// ---------------------------------------------------------------------------
// Channel handler
// ---------------------------------------------------------------------------

function handleCategoryEvent(event: unknown) {
  const data = event as Record<string, unknown>

  switch (data.type) {
    case 'categories':
      if (Array.isArray(data.categories)) {
        categories.value = (data.categories as Category[]).sort((a, b) =>
          a.categoryName.localeCompare(b.categoryName),
        )
      }
      loading.value = false
      break

    case 'ack':
      if (data.action === 'rename') {
        const idx = categories.value.findIndex(c => c.categoryId === data.categoryId)
        if (idx >= 0) categories.value[idx].categoryName = data.categoryName as string
        categories.value.sort((a, b) => a.categoryName.localeCompare(b.categoryName))
        renamingId.value = null
      }
      if (data.action === 'delete') {
        categories.value = categories.value.filter(c => c.categoryId !== data.categoryId)
        deletingId.value = null
      }
      if (data.action === 'create') {
        creatingCategory.value = true
        categoryStatus.value = { type: 'generating', name: data.categoryName as string, message: 'Starting…' }
      }
      break

    case 'category_progress':
      categoryStatus.value = {
        type: 'generating',
        name: data.categoryName as string,
        message: data.message as string,
      }
      break

    case 'category_created':
      categoryStatus.value = {
        type: 'created',
        name: data.categoryName as string,
        message: `${data.questionCount} questions (${data.easy}E/${data.medium}M/${data.hard}H)`,
      }
      creatingCategory.value = false
      // Refresh list
      publish('/categories/default', [{ action: 'list' }]).catch(() => {})
      break

    case 'category_error':
      categoryStatus.value = {
        type: 'error',
        name: data.categoryName as string,
        message: data.message as string,
      }
      creatingCategory.value = false
      break

    case 'error':
      console.error('[categories] Error:', data.message)
      break
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function fetchCategories() {
  await publish('/categories/default', [{ action: 'list' }])
}

async function createCategory() {
  const name = newCategoryName.value.trim()
  if (!name || name.length < 2) return
  newCategoryName.value = ''
  categoryStatus.value = null
  await publish('/categories/default', [{ action: 'create', categoryName: name }])
}

function startRename(cat: Category) {
  renamingId.value = cat.categoryId
  renameValue.value = cat.categoryName
}

function cancelRename() {
  renamingId.value = null
  renameValue.value = ''
}

async function submitRename(categoryId: string) {
  const name = renameValue.value.trim()
  if (!name || name.length < 2) return
  await publish('/categories/default', [{ action: 'rename', categoryId, categoryName: name }])
}

async function deleteCategory(categoryId: string) {
  deletingId.value = categoryId
  await publish('/categories/default', [{ action: 'delete', categoryId }])
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(async () => {
  if (!isAuthenticated()) {
    window.location.href = '/controller'
    return
  }
  authenticated.value = true

  const unsub = await subscribe('/categories/default', handleCategoryEvent)
  unsubscribers.push(unsub)
  await fetchCategories()
})

onUnmounted(() => {
  for (const unsub of unsubscribers) unsub()
})
</script>

<template>
  <div class="cats" v-if="authenticated">
    <div class="bg-grid" />
    <div class="bg-orb bg-orb-1" />
    <div class="bg-orb bg-orb-2" />

    <div class="cats-inner">
      <AppHeader active-page="categories" :show-nav="true" />

      <h1 class="page-title">Categories</h1>

      <!-- Create -->
      <div class="card create-card">
        <p class="card-label">Create New Category</p>
        <p class="card-hint">AI generates 60 trivia questions — research, generate, validate, save.</p>
        <div class="create-row">
          <input
            v-model="newCategoryName"
            type="text"
            placeholder="e.g. Space Exploration"
            maxlength="100"
            class="cat-input"
            :disabled="creatingCategory"
            @keyup.enter="createCategory"
          />
          <button
            class="btn btn-gold btn-create"
            :disabled="creatingCategory || newCategoryName.trim().length < 2"
            @click="createCategory"
          >
            {{ creatingCategory ? 'Generating…' : 'Generate' }}
          </button>
        </div>
        <div v-if="categoryStatus" :class="['status-bar', `status-${categoryStatus.type}`]">
          <span v-if="categoryStatus.type === 'generating'" class="status-icon">⏳</span>
          <span v-else-if="categoryStatus.type === 'created'" class="status-icon">✓</span>
          <span v-else class="status-icon">✗</span>
          <span>{{ categoryStatus.message }}</span>
        </div>
      </div>

      <!-- List -->
      <div class="card list-card">
        <p class="card-label">{{ categories.length }} Categories</p>

        <div v-if="loading" class="empty">Loading…</div>
        <div v-else-if="categories.length === 0" class="empty">No categories yet. Create one above.</div>

        <div v-else class="cat-list">
          <div v-for="cat in categories" :key="cat.categoryId" class="cat-row">
            <!-- Normal view -->
            <template v-if="renamingId !== cat.categoryId">
              <span class="cat-name">{{ cat.categoryName }}</span>
              <div class="cat-actions">
                <button class="act-btn" title="Rename" @click="startRename(cat)">✏️</button>
                <button
                  class="act-btn act-btn-danger"
                  title="Delete"
                  :disabled="deletingId === cat.categoryId"
                  @click="deleteCategory(cat.categoryId)"
                >
                  {{ deletingId === cat.categoryId ? '…' : '🗑️' }}
                </button>
              </div>
            </template>

            <!-- Rename view -->
            <template v-else>
              <input
                v-model="renameValue"
                type="text"
                class="rename-input"
                maxlength="100"
                @keyup.enter="submitRename(cat.categoryId)"
                @keyup.escape="cancelRename"
                autofocus
              />
              <div class="cat-actions">
                <button class="act-btn" @click="submitRename(cat.categoryId)">✓</button>
                <button class="act-btn" @click="cancelRename">✗</button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cats {
  min-height: 100svh;
  position: relative;
  overflow: hidden;
}

.cats-inner {
  position: relative;
  z-index: 1;
  max-width: 680px;
  margin: 0 auto;
  padding: 24px 20px 60px;
}

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

.bg-orb { position: fixed; border-radius: 50%; filter: blur(120px); pointer-events: none; }
.bg-orb-1 { width: 500px; height: 500px; background: var(--gold); opacity: 0.04; top: -200px; right: -150px; }
.bg-orb-2 { width: 400px; height: 400px; background: var(--cyan); opacity: 0.03; bottom: -150px; left: -100px; }

.page-title {
  font-size: 28px; font-weight: 800; margin-bottom: 24px;
}

/* Cards */
.card {
  background: var(--bg-card); border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg); padding: 24px;
  box-shadow: var(--shadow-card); margin-bottom: 16px;
}

.card-label {
  font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 1.5px; color: var(--text-muted); margin-bottom: 8px;
}

.card-hint { font-size: 13px; color: var(--text-muted); margin-bottom: 14px; }

/* Create */
.create-row { display: flex; gap: 8px; }

.cat-input {
  flex: 1; padding: 10px 14px;
  background: var(--bg-input); border: 1px solid var(--border-medium);
  border-radius: var(--radius-md); color: var(--text-primary);
  font-family: var(--font-display); font-size: 14px; outline: none;
  transition: border-color 0.2s; box-sizing: border-box;
}
.cat-input:focus { border-color: var(--gold); box-shadow: 0 0 0 3px var(--gold-glow); }
.cat-input::placeholder { color: var(--text-muted); }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: none; border-radius: var(--radius-md); font-family: var(--font-display); font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-gold { background: linear-gradient(135deg, var(--gold), #d97706); color: #0c0a1a; box-shadow: 0 2px 12px var(--gold-glow); }
.btn-gold:hover:not(:disabled) { box-shadow: var(--shadow-glow-gold); transform: translateY(-1px); }
.btn-create { padding: 10px 20px; white-space: nowrap; }

.status-bar {
  display: flex; align-items: flex-start; gap: 8px;
  margin-top: 12px; padding: 10px 14px; border-radius: var(--radius-sm); font-size: 13px;
}
.status-generating { background: var(--gold-subtle); border: 1px solid rgba(245, 158, 11, 0.2); color: var(--gold-light); }
.status-created { background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.2); color: var(--emerald); }
.status-error { background: rgba(244, 63, 94, 0.06); border: 1px solid rgba(244, 63, 94, 0.2); color: var(--rose); }
.status-icon { flex-shrink: 0; }

/* List */
.empty { color: var(--text-muted); font-size: 14px; padding: 20px 0; text-align: center; }

.cat-list { display: flex; flex-direction: column; }

.cat-row {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 0; border-bottom: 1px solid var(--border-subtle);
}
.cat-row:last-child { border-bottom: none; }

.cat-name { flex: 1; font-size: 15px; font-weight: 500; color: var(--text-primary); }

.cat-actions { display: flex; gap: 4px; flex-shrink: 0; }

.act-btn {
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  background: transparent; border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm); font-size: 14px; cursor: pointer;
  transition: all 0.15s;
}
.act-btn:hover { background: var(--bg-elevated); border-color: var(--border-medium); }
.act-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.act-btn-danger:hover { background: rgba(244, 63, 94, 0.08); border-color: rgba(244, 63, 94, 0.3); }

.rename-input {
  flex: 1; padding: 6px 10px;
  background: var(--bg-input); border: 1px solid var(--gold);
  border-radius: var(--radius-sm); color: var(--text-primary);
  font-family: var(--font-display); font-size: 14px; outline: none;
  box-shadow: 0 0 0 3px var(--gold-glow); box-sizing: border-box;
}
</style>