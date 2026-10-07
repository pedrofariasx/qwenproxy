import { test } from 'node:test';
import assert from 'node:assert';
import type { Page, Locator, FrameLocator } from 'playwright';
import { solveBaxiaCaptcha, startCaptchaWatcher } from '../../services/captcha-solver.js';

test('solveBaxiaCaptcha: returns false immediately if iframe is not visible', async () => {
  const mockLocator = {
    first: () => mockLocator,
    isVisible: async () => false,
  } as unknown as Locator;

  const mockPage = {
    locator: () => mockLocator,
  } as unknown as Page;

  const result = await solveBaxiaCaptcha(mockPage);
  assert.strictEqual(result, false);
});

test('solveBaxiaCaptcha: handles successful solve workflow', async () => {
  const mouseMoveCalls: any[] = [];
  let mouseDownCalls = 0;
  let mouseUpCalls = 0;
  let isVisibleCalls = 0;

  const mockIframeLocator = {
    first: () => mockIframeLocator,
    isVisible: async () => {
      isVisibleCalls++;
      // First check (to see if it exists): returns true
      // After solve check: returns false (captcha solved, iframe gone)
      return isVisibleCalls === 1;
    },
  } as unknown as Locator;

  const mockSlider = {
    waitFor: async () => {},
    boundingBox: async () => ({ x: 10, y: 20, width: 40, height: 40 }),
  } as unknown as Locator;

  const mockTrack = {
    boundingBox: async () => ({ x: 10, y: 20, width: 300, height: 40 }),
  } as unknown as Locator;

  const mockOkElement = {
    isVisible: async () => false,
  } as unknown as Locator;

  const mockFrameLocator = {
    locator: (selector: string) => {
      if (selector.includes('nc_1_n1z') || selector.includes('btn_slide')) {
        return mockSlider;
      }
      if (selector.includes('nc_1_n1t') || selector.includes('nc_scale')) {
        return mockTrack;
      }
      if (selector.includes('btn_ok') || selector.includes('nc_ok')) {
        return mockOkElement;
      }
      throw new Error(`Unexpected selector inside frame: ${selector}`);
    },
  } as unknown as FrameLocator;

  const mockPage = {
    locator: (selector: string) => {
      if (selector.includes('iframe')) {
        return mockIframeLocator;
      }
      throw new Error(`Unexpected page selector: ${selector}`);
    },
    frameLocator: (selector: string) => {
      if (selector.includes('iframe')) {
        return mockFrameLocator;
      }
      throw new Error(`Unexpected frame locator: ${selector}`);
    },
    mouse: {
      move: async (x: number, y: number) => {
        mouseMoveCalls.push({ x, y });
      },
      down: async () => {
        mouseDownCalls++;
      },
      up: async () => {
        mouseUpCalls++;
      },
    },
  } as unknown as Page;

  const result = await solveBaxiaCaptcha(mockPage);
  assert.strictEqual(result, true);
  assert.strictEqual(mouseDownCalls, 1);
  assert.strictEqual(mouseUpCalls, 1);
  assert.ok(mouseMoveCalls.length > 0);
});

test('startCaptchaWatcher: starts loop and stops on call', async () => {
  let isVisibleCalled = false;
  const mockLocator = {
    first: () => mockLocator,
    isVisible: async () => {
      isVisibleCalled = true;
      return false;
    },
  } as unknown as Locator;

  const mockPage = {
    isClosed: () => false,
    locator: () => mockLocator,
  } as unknown as Page;

  const watcher = startCaptchaWatcher(mockPage, 5000);
  // Wait a short duration to let the loop execute at least once
  await new Promise(resolve => setTimeout(resolve, 100));
  watcher.stop();
  await watcher.promise;

  assert.strictEqual(isVisibleCalled, true);
});
