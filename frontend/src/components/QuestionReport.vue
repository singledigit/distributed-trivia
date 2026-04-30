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
