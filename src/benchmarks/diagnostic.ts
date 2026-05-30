import { performance } from 'node:perf_hooks';
import { Logger } from '../core/logger.js';

const logger = new Logger('info', 'Diagnostic')

async function measurePlaywrightInit() {
  const start = performance.now();
  const { initPlaywright, getBasicHeaders } = await import('../services/playwright.ts');
  await initPlaywright();
  const initTime = performance.now() - start;
  
  const headerStart = performance.now();
  await getBasicHeaders();
  const headerTime = performance.now() - headerStart;
  
  return { initTime: initTime.toFixed(2), headerTime: headerTime.toFixed(2) };
}

async function measureNetworkLatency() {
  const { config } = await import('../core/config.ts');
  const start = performance.now();
  await fetch(`${config.qwen.baseUrl}/api/models`, {
    headers: { 'Accept': 'application/json' }
  }).catch(() => {});
  return { networkLatencyMs: (performance.now() - start).toFixed(2) };
}

async function runDiagnostic() {
  logger.info('=== Bottleneck Diagnostic ===\n');

  try {
    const pw = await measurePlaywrightInit();
    logger.info('Playwright:');
    logger.info(`  Browser init: ${pw.initTime}ms`);
    logger.info(`  Header fetch: ${pw.headerTime}ms`);
  } catch (e: any) {
    logger.info(`Playwright: SKIP (${e.message})`);
  }

  try {
    const net = await measureNetworkLatency();
    logger.info(`\nNetwork latency to Qwen: ${net.networkLatencyMs}ms`);
  } catch (e: any) {
    logger.info(`Network: SKIP (${e.message})`);
  }

  logger.info('\n=== Likely Bottlenecks ===');
  logger.info('1. getQwenHeaders() UI interactions: 2000-5000ms per call');
  logger.info('2. Global mutex (qwenChatMutex): serializes all chat requests');
  logger.info('3. No header caching between requests: re-fetches PoW each time');
  logger.info('4. Single browser context: no parallelism at browser level');
  logger.info('\nRecommendations:');
  logger.info('- Increase HEADERS_TTL in playwright.ts (currently 60min)');
  logger.info('- Pre-fetch headers on startup, not per-request');
  logger.info('- Consider request batching for concurrent users');
}

if (import.meta.main) {
  runDiagnostic().catch(err => logger.error('Diagnostic failed: ' + err));
}
