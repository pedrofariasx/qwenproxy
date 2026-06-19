import type { Page } from 'playwright';

function gaussianRandom(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function logNormalDelay(rng: () => number, minMs: number, maxMs: number): number {
  const mu = Math.log((minMs + maxMs) / 2);
  const sigma = 0.4;
  const val = Math.exp(mu + sigma * gaussianRandom(rng));
  return Math.max(minMs, Math.min(maxMs, Math.round(val)));
}

function cubicBezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let globalSeed = Date.now();
function simpleRng(): number {
  globalSeed = (globalSeed * 1103515245 + 12345) & 0x7fffffff;
  return globalSeed / 0x7fffffff;
}

export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.focus(selector);
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    if (simpleRng() < 0.03 && i > 0) {
      const wrongChar = String.fromCharCode(97 + Math.floor(simpleRng() * 26));
      await page.keyboard.type(wrongChar, { delay: logNormalDelay(simpleRng, 40, 120) });
      await sleep(logNormalDelay(simpleRng, 100, 300));
      await page.keyboard.press('Backspace');
      await sleep(logNormalDelay(simpleRng, 80, 200));
    }
    
    if (simpleRng() < 0.15 && char !== ' ' && i > 0) {
      await page.keyboard.down('Shift');
      await page.keyboard.type(char.toUpperCase(), { delay: logNormalDelay(simpleRng, 30, 90) });
      await page.keyboard.up('Shift');
      await sleep(logNormalDelay(simpleRng, 20, 60));
      await page.keyboard.press('Backspace');
      await sleep(logNormalDelay(simpleRng, 50, 150));
    }
    
    await page.keyboard.type(char, { delay: logNormalDelay(simpleRng, 35, 110) });
    
    if (char === ' ' || char === '.' || char === ',') {
      if (simpleRng() < 0.4) {
        await sleep(logNormalDelay(simpleRng, 150, 500));
      }
    }
    
    if (simpleRng() < 0.05) {
      await sleep(logNormalDelay(simpleRng, 200, 800));
    }
  }
}

export async function humanMouseMove(
  page: Page,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  options: { overshoot?: number; steps?: number; pauseAt?: number[] } = {}
): Promise<void> {
  const {
    overshoot = 5 + Math.floor(simpleRng() * 15),
    steps = 20 + Math.floor(simpleRng() * 15),
    pauseAt = [0.3, 0.7],
  } = options;

  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  
  const overshootX = toX + (dx > 0 ? overshoot : -overshoot);
  const overshootY = toY + (dy > 0 ? overshoot * 0.3 : -overshoot * 0.3);
  
  const cp1x = fromX + dx * 0.25 + gaussianRandom(simpleRng) * distance * 0.1;
  const cp1y = fromY + dy * 0.25 + gaussianRandom(simpleRng) * distance * 0.1;
  const cp2x = fromX + dx * 0.75 + gaussianRandom(simpleRng) * distance * 0.08;
  const cp2y = fromY + dy * 0.75 + gaussianRandom(simpleRng) * distance * 0.08;

  await page.mouse.move(fromX, fromY);
  
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    
    let x: number, y: number;
    if (t < 0.85) {
      const adjustedT = t / 0.85;
      x = cubicBezier(fromX, cp1x, cp2x, overshootX, adjustedT);
      y = cubicBezier(fromY, cp1y, cp2y, overshootY, adjustedT);
    } else {
      const correctionT = (t - 0.85) / 0.15;
      x = overshootX + (toX - overshootX) * correctionT;
      y = overshootY + (toY - overshootY) * correctionT;
    }
    
    x += gaussianRandom(simpleRng) * 1.5;
    y += gaussianRandom(simpleRng) * 1.5;
    
    await page.mouse.move(x, y, { steps: 2 });
    
    const shouldPause = pauseAt.some(p => Math.abs(t - p) < 0.05);
    if (shouldPause && simpleRng() < 0.6) {
      await sleep(logNormalDelay(simpleRng, 15, 50));
    }
    
    await sleep(logNormalDelay(simpleRng, 8, 25));
  }
  
  await page.mouse.move(toX, toY);
}

export async function humanDrag(
  page: Page,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Promise<void> {
  const startX = fromX + gaussianRandom(simpleRng) * 3;
  const startY = fromY + gaussianRandom(simpleRng) * 3;
  
  await humanMouseMove(page, startX + gaussianRandom(simpleRng) * 50, startY + gaussianRandom(simpleRng) * 50, startX, startY, { overshoot: 0, steps: 8 });
  await sleep(logNormalDelay(simpleRng, 100, 250));
  
  await page.mouse.move(startX, startY, { steps: 3 });
  await sleep(logNormalDelay(simpleRng, 80, 180));
  
  await page.mouse.down();
  await sleep(logNormalDelay(simpleRng, 60, 150));
  
  const dx = toX - startX;
  const dy = toY - startY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const overshoot = 8 + Math.floor(simpleRng() * 12);
  const steps = 30 + Math.floor(simpleRng() * 20);
  
  const cp1x = startX + dx * 0.3 + gaussianRandom(simpleRng) * distance * 0.05;
  const cp1y = startY + dy * 0.3 + gaussianRandom(simpleRng) * distance * 0.08;
  const cp2x = startX + dx * 0.7 + gaussianRandom(simpleRng) * distance * 0.05;
  const cp2y = startY + dy * 0.7 + gaussianRandom(simpleRng) * distance * 0.08;
  
  const overshootX = toX + (dx > 0 ? overshoot : -overshoot);
  const overshootY = toY + gaussianRandom(simpleRng) * 3;
  
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    
    let x: number, y: number;
    if (t < 0.8) {
      const adjustedT = t / 0.8;
      x = cubicBezier(startX, cp1x, cp2x, overshootX, adjustedT);
      y = cubicBezier(startY, cp1y, cp2y, overshootY, adjustedT);
    } else {
      const correctionT = (t - 0.8) / 0.2;
      const eased = 1 - Math.pow(1 - correctionT, 3);
      x = overshootX + (toX - overshootX) * eased;
      y = overshootY + (toY - overshootY) * eased;
    }
    
    x += gaussianRandom(simpleRng) * 1.2;
    y += gaussianRandom(simpleRng) * 1.2;
    
    await page.mouse.move(x, y, { steps: 2 });
    
    if (Math.abs(t - 0.3) < 0.03 || Math.abs(t - 0.65) < 0.03) {
      if (simpleRng() < 0.5) {
        await sleep(logNormalDelay(simpleRng, 20, 60));
      }
    }
    
    const accel = t < 0.3 ? 0.7 : t < 0.7 ? 1.0 : 1.3;
    await sleep(logNormalDelay(simpleRng, 10 * accel, 30 * accel));
  }
  
  await page.mouse.move(toX, toY);
  await sleep(logNormalDelay(simpleRng, 150, 350));
  
  await page.mouse.up();
}

export async function humanScroll(page: Page): Promise<void> {
  const scrollAmount = 100 + Math.floor(simpleRng() * 300);
  const direction = simpleRng() > 0.5 ? 1 : -1;
  
  await page.mouse.wheel(0, scrollAmount * direction);
  await sleep(logNormalDelay(simpleRng, 300, 800));
  
  if (simpleRng() < 0.3) {
    await page.mouse.wheel(0, scrollAmount * 0.3 * direction);
    await sleep(logNormalDelay(simpleRng, 200, 500));
  }
}

export async function humanPagePresence(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) return;
  
  const points = 3 + Math.floor(simpleRng() * 3);
  for (let i = 0; i < points; i++) {
    const x = Math.floor(simpleRng() * viewport.width);
    const y = Math.floor(simpleRng() * viewport.height);
    await humanMouseMove(page, 
      Math.floor(simpleRng() * viewport.width), 
      Math.floor(simpleRng() * viewport.height),
      x, y, 
      { overshoot: 0 }
    );
    await sleep(logNormalDelay(simpleRng, 500, 1500));
  }
  
  if (simpleRng() < 0.5) {
    await humanScroll(page);
  }
  
  await sleep(logNormalDelay(simpleRng, 1000, 3000));
}

export function humanDelay(minMs: number, maxMs: number): number {
  return logNormalDelay(simpleRng, minMs, maxMs);
}
