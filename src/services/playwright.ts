export type { BrowserType } from './browser-manager.js';
export {
  CHROME_UA,
  CHROME_CLIENT_HINTS,
  Mutex,
  activePage,
  resolveBrowserEngine,
  initPlaywright,
  closePlaywright,
  loginToQwen,
  initPlaywrightForAccount,
  launchManualLoginAccount,
  extractAccountInfoFromContext,
  closePlaywrightForAccount,
  getPageForAccount,
  saveStorageState,
} from './browser-manager.js';

export {
  getCookies,
  getBasicHeaders,
  getGuestHeaders,
  getQwenHeaders,
} from './header-interceptor.js';

export {
  browserFetch,
  browserStreamFetch,
} from './stream-bridge.js';

export { getStealthScript } from './stealth.js';
export { solveBaxiaCaptcha, startCaptchaWatcher } from './captcha-solver.js';
