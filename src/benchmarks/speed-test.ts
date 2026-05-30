import { performance } from 'node:perf_hooks';
import { config } from '../core/config.ts';
import { metrics } from '../core/metrics.ts';
import { Logger } from '../core/logger.js';

const logger = new Logger('info', 'SpeedTest')

interface BenchmarkResult {
  operation: string;
  avgMs: number;
  p95Ms: number;
  p99Ms: number;
  successRate: number;
  totalRequests: number;
}

async function benchmarkOperation(
  name: string,
  operation: () => Promise<void>,
  iterations: number = 10
): Promise<BenchmarkResult> {
  const timings: number[] = [];
  let successes = 0;

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    try {
      await operation();
      successes++;
      timings.push(performance.now() - start);
    } catch {
      timings.push(performance.now() - start);
    }
  }

  const sorted = [...timings].sort((a, b) => a - b);
  return {
    operation: name,
    avgMs: timings.reduce((a, b) => a + b, 0) / timings.length,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] || 0,
    p99Ms: sorted[Math.floor(sorted.length * 0.99)] || 0,
    successRate: (successes / iterations) * 100,
    totalRequests: iterations,
  };
}

async function runBenchmarks() {
  logger.info('=== QwenProxy Speed Benchmark ===\n');

  const results: BenchmarkResult[] = [];

  results.push(await benchmarkOperation(
    'getBasicHeaders (cached)',
    async () => {
      const { getBasicHeaders } = await import('../services/playwright.ts');
      await getBasicHeaders();
    },
    5
  ));

  results.push(await benchmarkOperation(
    'fetchQwenModels',
    async () => {
      const { fetchQwenModels } = await import('../services/qwen.ts');
      await fetchQwenModels();
    },
    3
  ));

  logger.info('Results:');
  console.table(results.map(r => ({
    Operation: r.operation,
    'Avg (ms)': r.avgMs.toFixed(2),
    'P95 (ms)': r.p95Ms.toFixed(2),
    'P99 (ms)': r.p99Ms.toFixed(2),
    'Success %': r.successRate.toFixed(1),
  })));

  const stats = metrics.getAll();
  logger.info('\nMetrics snapshot:');
  logger.info(JSON.stringify([...stats.entries()].map(([k, v]) => [k, Object.fromEntries(v.values)]), null, 2).slice(0, 2000));
}

if (import.meta.main) {
  runBenchmarks().catch(err => logger.error('Benchmark failed: ' + err));
}
