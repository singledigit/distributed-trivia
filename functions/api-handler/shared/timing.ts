/**
 * Lightweight timing and observability helpers.
 *
 * Emits structured JSON logs compatible with CloudWatch Logs Insights
 * and CloudWatch Embedded Metric Format (EMF) for dashboarding.
 *
 * No external dependencies — uses console.log with structured JSON.
 */

/** Log a timed operation with duration in milliseconds */
export async function timed<T>(
  operation: string,
  context: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    const duration = Date.now() - start;
    console.log(JSON.stringify({
      _type: 'timing',
      operation,
      duration,
      status: 'success',
      ...context,
    }));
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    console.log(JSON.stringify({
      _type: 'timing',
      operation,
      duration,
      status: 'error',
      error: (error as Error)?.message ?? String(error),
      ...context,
    }));
    throw error;
  }
}

/**
 * Emit a CloudWatch Embedded Metric Format (EMF) log.
 * CloudWatch automatically extracts these as custom metrics.
 *
 * @see https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html
 */
export function emitMetric(
  metricName: string,
  value: number,
  unit: 'Milliseconds' | 'Count' | 'None' = 'Milliseconds',
  dimensions: Record<string, string> = {},
) {
  const namespace = 'TriviaNight';
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: namespace,
        Dimensions: [Object.keys(dimensions)],
        Metrics: [{ Name: metricName, Unit: unit }],
      }],
    },
    [metricName]: value,
    ...dimensions,
  }));
}

/** Emit a latency metric with function name dimension */
export function emitLatency(operation: string, durationMs: number, functionName: string) {
  emitMetric(operation, durationMs, 'Milliseconds', { Function: functionName, Operation: operation });
}
