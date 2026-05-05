<script setup lang="ts">
import { ref, computed } from 'vue'

interface QuestionResult {
  questionNum: number
  questionText: string
  options: string[]
  correctAnswer: string
  difficulty: string
  points: number
  selectedOption: string | null
  isCorrect: boolean
  wasSkipped: boolean
}

const props = defineProps<{
  results: QuestionResult[]
}>()

const showReport = ref(false)

const correctCount = computed(() => props.results.filter(r => r.isCorrect).length)
const incorrectCount = computed(() => props.results.filter(r => !r.isCorrect && !r.wasSkipped).length)
const skippedCount = computed(() => props.results.filter(r => r.wasSkipped).length)
</script>

<template>
  <div v-if="results.length > 0" class="report-summary">
    <div class="report-pills">
      <span class="rpill rpill-correct">{{ correctCount }} correct</span>
      <span class="rpill rpill-wrong">{{ incorrectCount }} wrong</span>
      <span v-if="skippedCount > 0" class="rpill rpill-skip">{{ skippedCount }} skipped</span>
    </div>
    <button class="btn-report" @click="showReport = !showReport">
      {{ showReport ? 'Hide' : 'Review' }} Answers
      <span :class="['report-arrow', { open: showReport }]">▾</span>
    </button>
  </div>

  <div v-if="showReport && results.length > 0" class="report">
    <div
      v-for="r in results"
      :key="r.questionNum"
      :class="['report-item', { 'ri-correct': r.isCorrect, 'ri-wrong': !r.isCorrect && !r.wasSkipped, 'ri-skip': r.wasSkipped }]"
    >
      <div class="ri-header">
        <span class="ri-num">Q{{ r.questionNum }}</span>
        <span :class="['ri-badge', `ri-badge-${r.difficulty}`]">{{ r.difficulty }}</span>
        <span class="ri-pts">{{ r.points }} pts</span>
        <span class="ri-result">
          <span v-if="r.isCorrect" role="img" aria-label="Correct">✓</span>
          <span v-else-if="r.wasSkipped" aria-label="Skipped">—</span>
          <span v-else role="img" aria-label="Incorrect">✗</span>
        </span>
      </div>
      <div class="ri-question">{{ r.questionText }}</div>
      <div v-if="!r.isCorrect" class="ri-answer">
        <span v-if="r.selectedOption" class="ri-yours">Your answer: {{ r.selectedOption }}</span>
        <span v-else class="ri-yours">Skipped</span>
        <span class="ri-correct-answer">Correct: {{ r.correctAnswer }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.report-summary {
  text-align: center;
  margin-top: 1.5rem;
}

.report-pills {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.rpill {
  display: inline-flex;
  align-items: center;
  padding: 4px 12px;
  border-radius: var(--radius-full, 999px);
  font-size: 13px;
  font-weight: 600;
}

.rpill-correct {
  background: rgba(16, 185, 129, 0.12);
  color: var(--emerald, #10b981);
  border: 1px solid rgba(16, 185, 129, 0.3);
}

.rpill-wrong {
  background: rgba(244, 63, 94, 0.08);
  color: var(--rose, #f43f5e);
  border: 1px solid rgba(244, 63, 94, 0.3);
}

.rpill-skip {
  background: rgba(245, 158, 11, 0.08);
  color: var(--gold, #f59e0b);
  border: 1px solid rgba(245, 158, 11, 0.3);
}

.btn-report {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--bg-card, #1a1a2e);
  border: 1px solid var(--border-subtle, #2a2a4a);
  border-radius: var(--radius-md, 8px);
  color: var(--text-secondary, #a0a0b0);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-report:hover {
  border-color: var(--border-strong, #4a4a6a);
  color: var(--text-primary, #f0f0f0);
}

.report-arrow {
  transition: transform 0.2s;
  font-size: 11px;
}

.report-arrow.open {
  transform: rotate(180deg);
}

.report {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.report-item {
  background: var(--bg-card, #1a1a2e);
  border: 1px solid var(--border-subtle, #2a2a4a);
  border-radius: var(--radius-md, 8px);
  padding: 12px 16px;
  text-align: left;
}

.report-item.ri-correct {
  border-left: 3px solid var(--emerald, #10b981);
}

.report-item.ri-wrong {
  border-left: 3px solid var(--rose, #f43f5e);
}

.report-item.ri-skip {
  border-left: 3px solid var(--gold, #f59e0b);
}

.ri-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.ri-num {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  font-weight: 700;
  color: var(--text-muted, #6a6a8a);
}

.ri-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: var(--radius-full, 999px);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.ri-badge-easy {
  background: rgba(16, 185, 129, 0.1);
  color: var(--emerald, #10b981);
}

.ri-badge-medium {
  background: rgba(245, 158, 11, 0.1);
  color: var(--gold, #f59e0b);
}

.ri-badge-hard {
  background: rgba(244, 63, 94, 0.08);
  color: var(--rose, #f43f5e);
}

.ri-pts {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--text-muted, #6a6a8a);
  margin-left: auto;
}

.ri-result {
  font-size: 16px;
  font-weight: 700;
}

.ri-correct .ri-result { color: var(--emerald, #10b981); }
.ri-wrong .ri-result { color: var(--rose, #f43f5e); }
.ri-skip .ri-result { color: var(--gold, #f59e0b); }

.ri-question {
  font-size: 14px;
  color: var(--text-primary, #f0f0f0);
  line-height: 1.4;
  margin-bottom: 4px;
}

.ri-answer {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border-subtle, #2a2a4a);
  font-size: 13px;
}

.ri-yours {
  color: var(--rose, #f43f5e);
}

.ri-correct-answer {
  color: var(--emerald, #10b981);
}
</style>
