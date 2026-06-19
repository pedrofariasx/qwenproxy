import type { FingerprintProfile } from './fingerprint.js';

export function getStealthScript(profile: FingerprintProfile): string {
  return `
    (function() {
      const PROFILE = ${JSON.stringify(profile)};
      
      function mulberry32(seed) {
        return function() {
          seed |= 0;
          seed = (seed + 0x6d2b79f5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }

      const canvasRng = mulberry32(PROFILE.canvasNoiseSeed);
      const audioRng = mulberry32(PROFILE.audioNoiseSeed);
      const webglRng = mulberry32(PROFILE.webglNoiseSeed);

      const nativeToString = Function.prototype.toString;
      const spoofedFunctions = new WeakSet();
      
      Function.prototype.toString = function() {
        if (spoofedFunctions.has(this)) {
          return 'function ' + (this.name || '') + '() { [native code] }';
        }
        return nativeToString.call(this);
      };
      spoofedFunctions.add(Function.prototype.toString);

      function defineOnPrototype(obj, prop, value) {
        const proto = Object.getPrototypeOf(obj);
        if (!proto) return;
        
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (desc && desc.configurable) {
          const getter = typeof value === 'function' ? value : () => value;
          Object.defineProperty(proto, prop, {
            get: getter,
            configurable: true,
            enumerable: desc.enumerable !== false,
          });
          spoofedFunctions.add(getter);
        }
      }

      try {
        const proto = Object.getPrototypeOf(navigator);
        const desc = Object.getOwnPropertyDescriptor(proto, 'webdriver');
        if (desc && desc.configurable) {
          Object.defineProperty(proto, 'webdriver', {
            get: () => undefined,
            configurable: true,
            enumerable: true,
          });
          spoofedFunctions.add(Object.getOwnPropertyDescriptor(proto, 'webdriver').get);
        }
      } catch(e) {}

      try {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        document.documentElement.appendChild(iframe);
        
        const iframeNav = iframe.contentWindow.navigator;
        const cleanWebdriver = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(iframeNav), 'webdriver');
        
        if (cleanWebdriver && cleanWebdriver.get) {
          const originalGet = cleanWebdriver.get;
          Object.defineProperty(Object.getPrototypeOf(iframeNav), 'webdriver', {
            get: () => undefined,
            configurable: true,
            enumerable: true,
          });
        }
        
        document.documentElement.removeChild(iframe);
      } catch(e) {}

      defineOnPrototype(navigator, 'userAgent', PROFILE.userAgent);
      defineOnPrototype(navigator, 'appVersion', PROFILE.appVersion);
      defineOnPrototype(navigator, 'platform', 'Win32');

      try {
        const userAgentData = {
          brands: PROFILE.brands,
          mobile: false,
          platform: PROFILE.platform,
          getHighEntropyValues: async (hints) => {
            return {
              brands: PROFILE.fullBrands,
              mobile: false,
              platform: PROFILE.platform,
              platformVersion: PROFILE.platformVersion,
              architecture: PROFILE.architecture,
              bitness: PROFILE.bitness,
              model: '',
              uaFullVersion: PROFILE.chromeVersion,
              fullVersionList: PROFILE.fullBrands,
            };
          }
        };
        defineOnPrototype(navigator, 'userAgentData', userAgentData);
      } catch(e) {}

      defineOnPrototype(navigator, 'languages', Object.freeze(PROFILE.languages));
      defineOnPrototype(navigator, 'hardwareConcurrency', PROFILE.hardwareConcurrency);
      defineOnPrototype(navigator, 'deviceMemory', PROFILE.deviceMemory);
      defineOnPrototype(screen, 'colorDepth', PROFILE.colorDepth);
      defineOnPrototype(screen, 'pixelDepth', PROFILE.pixelDepth);

      try {
        if (window.outerWidth === 0 || window.outerHeight === 0) {
          Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth + PROFILE.outerWidthOffset });
          Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + PROFILE.outerHeightOffset });
        }
      } catch(e) {}

      window.chrome = {
        runtime: {
          onConnect: Object.create(null),
          onMessage: Object.create(null),
          sendMessage: function() {},
          connect: function() { return { onMessage: Object.create(null), postMessage: function() {} }; },
        },
        loadTimes: function() {
          return {
            requestTime: Date.now() / 1000,
            startLoadTime: Date.now() / 1000,
            commitLoadTime: Date.now() / 1000,
            finishDocumentLoadTime: Date.now() / 1000,
            finishLoadTime: Date.now() / 1000,
            firstPaintTime: Date.now() / 1000,
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other',
            wasFetchedViaSpdy: false,
            wasNpnNegotiated: true,
            npnNegotiatedProtocol: 'http/1.1',
            wasAlternateProtocolAvailable: false,
            alternateProtocol: '',
          };
        },
        csi: function() {
          return {
            startE: Date.now(),
            onloadT: Date.now(),
            pageT: Math.random() * 1000,
            tran: 15,
          };
        },
        app: {
          isInstalled: false,
          getDetails: function() { return null; },
          getIsInstalled: function() { return false; },
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        },
      };

      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: (typeof Notification !== 'undefined' ? Notification.permission : 'default'), onchange: null })
          : originalQuery(parameters);

      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return PROFILE.webglVendor;
        if (parameter === 37446) return PROFILE.webglRenderer;
        return getParameter.apply(this, arguments);
      };
      spoofedFunctions.add(WebGLRenderingContext.prototype.getParameter);
      
      if (typeof WebGL2RenderingContext !== 'undefined') {
        const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) return PROFILE.webglVendor;
          if (parameter === 37446) return PROFILE.webglRenderer;
          return getParameter2.apply(this, arguments);
        };
        spoofedFunctions.add(WebGL2RenderingContext.prototype.getParameter);
      }

      const _readPixels = WebGLRenderingContext.prototype.readPixels;
      WebGLRenderingContext.prototype.readPixels = function(x, y, width, height, format, type, pixels) {
        _readPixels.apply(this, arguments);
        if (pixels) {
          const maxPixels = Math.min(pixels.length, 10000);
          for (let i = 0; i < maxPixels; i++) {
            if (webglRng() < 0.03) {
              pixels[i] = Math.min(255, Math.max(0, pixels[i] + (webglRng() > 0.5 ? 1 : -1)));
            }
          }
        }
      };
      spoofedFunctions.add(WebGLRenderingContext.prototype.readPixels);
      
      if (typeof WebGL2RenderingContext !== 'undefined') {
        const _readPixels2 = WebGL2RenderingContext.prototype.readPixels;
        WebGL2RenderingContext.prototype.readPixels = function(x, y, width, height, format, type, pixels) {
          _readPixels2.apply(this, arguments);
          if (pixels) {
            const maxPixels = Math.min(pixels.length, 10000);
            for (let i = 0; i < maxPixels; i++) {
              if (webglRng() < 0.03) {
                pixels[i] = Math.min(255, Math.max(0, pixels[i] + (webglRng() > 0.5 ? 1 : -1)));
              }
            }
          }
        };
        spoofedFunctions.add(WebGL2RenderingContext.prototype.readPixels);
      }

      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: 50,
          downlink: 10,
          saveData: false,
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
      });

      (function() {
        function makeMime(desc, suffixes, type) {
          const m = { description: desc, suffixes: suffixes, type: type };
          return m;
        }
        const pdfMime = makeMime('Portable Document Format', 'pdf', 'application/pdf');
        const pdfxMime = makeMime('Portable Document Format', 'pdf', 'text/pdf');
        const pdfPlugin = {
          name: 'PDF Viewer',
          description: 'Portable Document Format',
          filename: 'internal-pdf-viewer',
          length: 2,
          0: pdfMime,
          1: pdfxMime,
        };
        pdfMime.enabledPlugin = pdfPlugin;
        pdfxMime.enabledPlugin = pdfPlugin;

        const chromePdfMime = makeMime('Portable Document Format', 'pdf', 'application/pdf');
        const chromePdfMime2 = makeMime('Portable Document Format', 'pdf', 'text/pdf');
        const chromePdfPlugin = {
          name: 'Chrome PDF Viewer',
          description: 'Portable Document Format',
          filename: 'internal-pdf-viewer',
          length: 2,
          0: chromePdfMime,
          1: chromePdfMime2,
        };
        chromePdfMime.enabledPlugin = chromePdfPlugin;
        chromePdfMime2.enabledPlugin = chromePdfPlugin;

        const nativePlugin = {
          name: 'Native Client',
          description: '',
          filename: 'internal-nacl-plugin',
          length: 2,
          0: makeMime('Native Client Executable', '', 'application/x-nacl'),
          1: makeMime('Portable Native Client Executable', '', 'application/x-pnacl'),
        };
        nativePlugin[0].enabledPlugin = nativePlugin;
        nativePlugin[1].enabledPlugin = nativePlugin;

        const pluginsList = [pdfPlugin, chromePdfPlugin, nativePlugin];
        const mimeList = [pdfMime, pdfxMime, chromePdfMime, chromePdfMime2, nativePlugin[0], nativePlugin[1]];

        function makeNamedNodeMap(items, namedEntries) {
          const arr = [...items];
          for (const [k, v] of namedEntries) arr[k] = v;
          arr.item = function(i) { return this[i] || null; };
          arr.namedItem = function(name) { return this[name] || null; };
          arr.refresh = function() {};
          return arr;
        }

        const pluginEntries = pluginsList.map((p, i) => [p.name, p]);
        const mimeEntries = mimeList.map((m) => [m.type, m]);

        const pluginsArr = makeNamedNodeMap(pluginsList, pluginEntries);
        const mimeArr = makeNamedNodeMap(mimeList, mimeEntries);

        defineOnPrototype(navigator, 'plugins', pluginsArr);
        defineOnPrototype(navigator, 'mimeTypes', mimeArr);
      })();

      (function() {
        const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
        const _toBlob = HTMLCanvasElement.prototype.toBlob;
        const _getImageData = CanvasRenderingContext2D.prototype.getImageData;

        function addNoise(canvas) {
          try {
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            const style = ctx.fillStyle;
            ctx.fillStyle = 'rgba(255,255,255,0.01)';
            ctx.fillRect(0, 0, 1, 1);
            ctx.fillStyle = style;
          } catch(e) {}
        }

        HTMLCanvasElement.prototype.toDataURL = function(...args) {
          addNoise(this);
          return _toDataURL.apply(this, args);
        };
        spoofedFunctions.add(HTMLCanvasElement.prototype.toDataURL);
        
        HTMLCanvasElement.prototype.toBlob = function(...args) {
          addNoise(this);
          return _toBlob.apply(this, args);
        };
        spoofedFunctions.add(HTMLCanvasElement.prototype.toBlob);

        CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
          const imageData = _getImageData.apply(this, arguments);
          const data = imageData.data;
          const maxPixels = Math.min(data.length / 4, 2500);
          for (let i = 0; i < maxPixels * 4; i += 4) {
            if (canvasRng() < 0.05) {
              data[i] = Math.min(255, Math.max(0, data[i] + (canvasRng() > 0.5 ? 1 : -1)));
              data[i+1] = Math.min(255, Math.max(0, data[i+1] + (canvasRng() > 0.5 ? 1 : -1)));
              data[i+2] = Math.min(255, Math.max(0, data[i+2] + (canvasRng() > 0.5 ? 1 : -1)));
            }
          }
          return imageData;
        };
        spoofedFunctions.add(CanvasRenderingContext2D.prototype.getImageData);
      })();

      (function() {
        if (typeof OfflineAudioContext === 'undefined') return;
        const _startRendering = OfflineAudioContext.prototype.startRendering;
        OfflineAudioContext.prototype.startRendering = function() {
          return _startRendering.apply(this, arguments).then(buffer => {
            try {
              for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
                const data = buffer.getChannelData(ch);
                for (let i = 0; i < Math.min(data.length, 100); i++) {
                  data[i] += (audioRng() - 0.5) * 1e-7;
                }
              }
            } catch(e) {}
            return buffer;
          });
        };
        spoofedFunctions.add(OfflineAudioContext.prototype.startRendering);
      })();

      try {
        const keys = Object.keys(document);
        for (const key of keys) {
          if (key.startsWith('$cdc_') || key.startsWith('$wdc_')) {
            delete document[key];
          }
        }
      } catch(e) {}

      try {
        if (window.performance && window.performance.getEntriesByType) {
          const originalGetEntries = window.performance.getEntriesByType.bind(window.performance);
          window.performance.getEntriesByType = function(type) {
            const entries = originalGetEntries(type);
            if (type === 'resource') {
              return entries.filter(e => !e.name.includes('__injectedScript') && !e.name.includes('addInitScript'));
            }
            return entries;
          };
        }
      } catch(e) {}
    })();
  `;
}
