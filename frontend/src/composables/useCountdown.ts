import { ref, onUnmounted } from 'vue'

/**
 * Reactive countdown to a target ISO timestamp.
 * Returns the remaining seconds and control functions.
 */
export function useCountdown() {
  const seconds = ref(0)
  let interval: ReturnType<typeof setInterval> | null = null

  function start(targetTime: string, onComplete?: () => void) {
    stop()
    const targetMs = new Date(targetTime).getTime()

    const tick = () => {
      const diff = Math.max(0, Math.ceil((targetMs - Date.now()) / 1000))
      seconds.value = diff
      if (diff <= 0) {
        stop()
        onComplete?.()
      }
    }

    tick()
    interval = setInterval(tick, 250)
  }

  function stop() {
    if (interval) {
      clearInterval(interval)
      interval = null
    }
    seconds.value = 0
  }

  onUnmounted(stop)

  return { seconds, start, stop }
}
