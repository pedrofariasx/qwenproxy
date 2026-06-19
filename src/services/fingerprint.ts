function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return hash >>> 0;
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

const WEBGL_VENDORS = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1600, height: 900 },
  { width: 1680, height: 1050 },
  { width: 1280, height: 720 },
  { width: 1280, height: 800 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1200 },
];

const HARDWARE_CONCURRENCIES = [4, 6, 8, 8, 8, 12, 16, 16, 24, 32];
const DEVICE_MEMORIES = [4, 8, 8, 8, 16, 16, 32];

const PLATFORM_VERSIONS = [
  { platform: 'Windows', platformVersion: '14.0.0', major: '10' },
  { platform: 'Windows', platformVersion: '15.0.0', major: '11' },
  { platform: 'Windows', platformVersion: '14.0.0', major: '10' },
  { platform: 'Windows', platformVersion: '15.0.0', major: '11' },
];

const CHROME_MAJOR = 137;

function generateChromeVersion(rng: () => number): string {
  const build = randInt(rng, 6800, 7200);
  const patch = randInt(rng, 0, 200);
  return `${CHROME_MAJOR}.0.${build}.${patch}`;
}

const NOT_A_BRAND_VARIANTS = [
  { brand: 'Not/A)Brand', version: '99' },
  { brand: 'Not)A_Brand', version: '99' },
  { brand: 'Not/A)Brand', version: '8' },
  { brand: 'Not?A_Brand', version: '24' },
  { brand: 'Not/A)Brand', version: '99' },
];

const LANGUAGE_PROFILES = [
  ['pt-BR', 'pt', 'en-US', 'en'],
  ['pt-BR', 'pt', 'en-US', 'en', 'es'],
  ['pt-BR', 'pt', 'en'],
  ['pt-BR', 'en-US', 'en', 'pt'],
  ['pt-BR', 'pt;q=0.9', 'en-US;q=0.8', 'en;q=0.7'],
];

export interface FingerprintProfile {
  accountId: string;
  prngSeed: number;
  userAgent: string;
  appVersion: string;
  chromeVersion: string;
  chromeMajor: number;
  platform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  brands: Array<{ brand: string; version: string }>;
  fullBrands: Array<{ brand: string; version: string }>;
  secChUa: string;
  viewport: { width: number; height: number };
  hardwareConcurrency: number;
  deviceMemory: number;
  languages: string[];
  webglVendor: string;
  webglRenderer: string;
  colorDepth: number;
  pixelDepth: number;
  canvasNoiseSeed: number;
  audioNoiseSeed: number;
  webglNoiseSeed: number;
  outerWidthOffset: number;
  outerHeightOffset: number;
}

const profileCache = new Map<string, FingerprintProfile>();

export function getFingerprintProfile(accountId: string): FingerprintProfile {
  const cached = profileCache.get(accountId);
  if (cached) return cached;

  const seed = seedFromString(accountId);
  const rng = mulberry32(seed);

  const chromeVersion = generateChromeVersion(rng);
  const chromeMajor = CHROME_MAJOR;
  const notABrand = pick(rng, NOT_A_BRAND_VARIANTS);
  const platformInfo = pick(rng, PLATFORM_VERSIONS);
  const viewport = pick(rng, VIEWPORTS);
  const hardwareConcurrency = pick(rng, HARDWARE_CONCURRENCIES);
  const deviceMemory = pick(rng, DEVICE_MEMORIES);
  const languages = pick(rng, LANGUAGE_PROFILES);
  const webgl = pick(rng, WEBGL_VENDORS);

  const ua = `Mozilla/5.0 (Windows NT ${platformInfo.major}.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  const appVersion = ua.replace('Mozilla/', '');

  const brands = [
    { brand: notABrand.brand, version: notABrand.version },
    { brand: 'Google Chrome', version: String(chromeMajor) },
    { brand: 'Chromium', version: String(chromeMajor) },
  ];

  const chromeFullVersion = chromeVersion;
  const fullBrands = [
    { brand: notABrand.brand, version: chromeFullVersion },
    { brand: 'Google Chrome', version: chromeFullVersion },
    { brand: 'Chromium', version: chromeFullVersion },
  ];

  const secChUa = `"${brands[0].brand}";v="${brands[0].version}", "${brands[1].brand}";v="${brands[1].version}", "${brands[2].brand}";v="${brands[2].version}"`;

  const profile: FingerprintProfile = {
    accountId,
    prngSeed: seed,
    userAgent: ua,
    appVersion,
    chromeVersion,
    chromeMajor,
    platform: platformInfo.platform,
    platformVersion: platformInfo.platformVersion,
    architecture: 'x86',
    bitness: '64',
    brands,
    fullBrands,
    secChUa,
    viewport,
    hardwareConcurrency,
    deviceMemory,
    languages,
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    colorDepth: 24,
    pixelDepth: 24,
    canvasNoiseSeed: randInt(rng, 1, 2147483647),
    audioNoiseSeed: randInt(rng, 1, 2147483647),
    webglNoiseSeed: randInt(rng, 1, 2147483647),
    outerWidthOffset: randInt(rng, 0, 20),
    outerHeightOffset: randInt(rng, 75, 95),
  };

  profileCache.set(accountId, profile);
  return profile;
}

export function clearFingerprintCache(accountId?: string): void {
  if (accountId) {
    profileCache.delete(accountId);
  } else {
    profileCache.clear();
  }
}
