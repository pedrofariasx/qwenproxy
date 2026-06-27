## [1.12.3](https://github.com/pedrofariasx/qwenproxy/compare/v1.12.2...v1.12.3) (2026-06-27)


### Bug Fixes

* repair docker volume permissions ([07633f8](https://github.com/pedrofariasx/qwenproxy/commit/07633f85544feedc0e6d38b1965b1c2ac823cc7f))

## [1.12.2](https://github.com/pedrofariasx/qwenproxy/compare/v1.12.1...v1.12.2) (2026-06-23)


### Bug Fixes

* improve editor tool call parsing ([62e6fac](https://github.com/pedrofariasx/qwenproxy/commit/62e6fac754c0ccbcd1547b9ad8717c2ab1001ce1))

## [1.12.1](https://github.com/pedrofariasx/qwenproxy/compare/v1.12.0...v1.12.1) (2026-06-22)


### Bug Fixes

* keep qwen lanes on stable page ([1458070](https://github.com/pedrofariasx/qwenproxy/commit/14580709e02a91c426df666307c7411bb601238c))

# [1.12.0](https://github.com/pedrofariasx/qwenproxy/compare/v1.11.0...v1.12.0) (2026-06-22)


### Features

* isolate single-account concurrency lanes ([ba953e8](https://github.com/pedrofariasx/qwenproxy/commit/ba953e8ce17a337582f971381c257ae3d7fc1ff8))

# [1.11.0](https://github.com/pedrofariasx/qwenproxy/compare/v1.10.2...v1.11.0) (2026-06-22)


### Features

* improve tool calls and qwen anti-bot settings ([94f92ce](https://github.com/pedrofariasx/qwenproxy/commit/94f92cea452c3aec9ed54d45351d366f215c9410))

## [1.10.2](https://github.com/pedrofariasx/qwenproxy/compare/v1.10.1...v1.10.2) (2026-06-21)


### Bug Fixes

* sequentialize account init, validate storage state, use headless=new and increase timeouts ([46cdcc0](https://github.com/pedrofariasx/qwenproxy/commit/46cdcc03551b7cc366a08de59fd7b28ddad96299))

## [1.10.1](https://github.com/pedrofariasx/qwenproxy/compare/v1.10.0...v1.10.1) (2026-06-21)


### Bug Fixes

* add mouse lock to prevent session-keeper interference during captcha solving ([121bc01](https://github.com/pedrofariasx/qwenproxy/commit/121bc01555636e0ae5886763f8925b85cc2bda5e))

# [1.10.0](https://github.com/pedrofariasx/qwenproxy/compare/v1.9.0...v1.10.0) (2026-06-21)


### Features

* add session keep-alive to prevent captcha after inactivity ([efb2183](https://github.com/pedrofariasx/qwenproxy/commit/efb2183ad3bba5c7fac497988f712f163b510c9a))

# [1.9.0](https://github.com/pedrofariasx/qwenproxy/compare/v1.8.0...v1.9.0) (2026-06-21)


### Features

* implement advanced anti-detection with deterministic fingerprints and humanized behavior ([f2af6d7](https://github.com/pedrofariasx/qwenproxy/commit/f2af6d70bb45faf94d8b2f1c47b52cd775c49ff3))

# [1.8.0](https://github.com/pedrofariasx/qwenproxy/compare/v1.7.3...v1.8.0) (2026-06-19)


### Bug Fixes

* resolve lint errors in captcha-solver and captcha test ([5083df0](https://github.com/pedrofariasx/qwenproxy/commit/5083df00ee0afff8a90c91ac350b391d62d86b6b))


### Features

* add automated Baxia captcha solver and enhance anti-detection fingerprint ([7eda9bc](https://github.com/pedrofariasx/qwenproxy/commit/7eda9bca2530949d396b5f0481665a59644816b7))

## [1.7.3](https://github.com/pedrofariasx/qwenproxy/compare/v1.7.2...v1.7.3) (2026-06-18)


### Bug Fixes

* prevent unhandled promise rejection in stream bridge body ([be6c7b8](https://github.com/pedrofariasx/qwenproxy/commit/be6c7b80b5741828ccd452ddaf116005e22a0908))

## [1.7.2](https://github.com/pedrofariasx/qwenproxy/compare/v1.7.1...v1.7.2) (2026-06-17)


### Performance Improvements

* optimize Docker setup with noble base, shm_size, resource limits and healthcheck ([f0196e2](https://github.com/pedrofariasx/qwenproxy/commit/f0196e2afb93418053ff15c4ec057b7bc7d0d1c1))

## [1.7.1](https://github.com/pedrofariasx/qwenproxy/compare/v1.7.0...v1.7.1) (2026-06-16)


### Performance Improvements

* use shared browser instance with isolated contexts to reduce RAM usage ([6b58072](https://github.com/pedrofariasx/qwenproxy/commit/6b580724ba023e9ddeaabdf68a02a3bc68cc144d))

# [1.7.0](https://github.com/pedrofariasx/qwenproxy/compare/v1.6.4...v1.7.0) (2026-06-15)


### Features

* improve large-context tool-call reliability ([dcc0ac1](https://github.com/pedrofariasx/qwenproxy/commit/dcc0ac10ff988a3c2b55d2cf689cf3cb0283c8b8))

## [1.6.4](https://github.com/pedrofariasx/qwenproxy/compare/v1.6.3...v1.6.4) (2026-06-12)


### Performance Improvements

* make all timeouts configurable via env and increase defaults for slow connections ([c0c486a](https://github.com/pedrofariasx/qwenproxy/commit/c0c486af46a3a65e5eb15c26268a66b038c3d764))
* reuse existing unused chats from API before creating new ones in warm pool ([3ce801b](https://github.com/pedrofariasx/qwenproxy/commit/3ce801b181d1facfbe13a5c7dfd1aa2e6d9c90ed))

## [1.6.3](https://github.com/pedrofariasx/qwenproxy/compare/v1.6.2...v1.6.3) (2026-06-12)


### Bug Fixes

* restore header interception by reverting to click-first send logic with Enter fallback ([f994a53](https://github.com/pedrofariasx/qwenproxy/commit/f994a53ed1de17e9b8c315d9bd67efcd5e44d909))

## [1.6.2](https://github.com/pedrofariasx/qwenproxy/compare/v1.6.1...v1.6.2) (2026-06-12)


### Bug Fixes

* restore header interception reliability by increasing input/update delays ([7cd31c4](https://github.com/pedrofariasx/qwenproxy/commit/7cd31c4589558a2bcf2a1fb4b4f5c89dbe3f8790))

## [1.6.1](https://github.com/pedrofariasx/qwenproxy/compare/v1.6.0...v1.6.1) (2026-06-12)


### Performance Improvements

* reduce latency spikes with warm pool low-water mark and cache optimizations ([481f7c5](https://github.com/pedrofariasx/qwenproxy/commit/481f7c5d37061d5949f838f7ebc9003cd37c9414))

# [1.6.0](https://github.com/pedrofariasx/qwenproxy/compare/v1.5.1...v1.6.0) (2026-06-11)


### Features

* route API requests through browser fetch for real TLS fingerprint and harden stealth ([b32d66a](https://github.com/pedrofariasx/qwenproxy/commit/b32d66a4e2929cbf383179aa282899939833bd7f))

## [1.5.1](https://github.com/pedrofariasx/qwenproxy/compare/v1.5.0...v1.5.1) (2026-06-10)


### Bug Fixes

* prevent guest mode timeout when bx-ua is missing in intercepted request ([b859ae7](https://github.com/pedrofariasx/qwenproxy/commit/b859ae779ed79116bc333ef507ed96fdb44e0f2a))

# [1.5.0](https://github.com/pedrofariasx/qwenproxy/compare/v1.4.0...v1.5.0) (2026-06-10)


### Features

* add QWEN_GUEST_MODE_ONLY environment variable to bypass account rotation ([ea928cd](https://github.com/pedrofariasx/qwenproxy/commit/ea928cd09ab3842b211f7c2b569a189542da8b04))

# [1.4.0](https://github.com/pedrofariasx/qwenproxy/compare/v1.3.3...v1.4.0) (2026-06-10)


### Bug Fixes

* auto-recover missing headers and validate sessions on account init ([54c9f11](https://github.com/pedrofariasx/qwenproxy/commit/54c9f112e0470297ba0c69a611f75a3fd2e05e62))
* revert request gzip compression, allow optional model IDs in registry, and persist cooldowns ([e756781](https://github.com/pedrofariasx/qwenproxy/commit/e75678172d429e68043dd3db96ffafd9d5a47875))


### Features

* improve account cooldown logic and warm pool rate-limit handling ([f9d4b9d](https://github.com/pedrofariasx/qwenproxy/commit/f9d4b9d6e6a0576afd5f648fb21db93bc5137b73))


### Performance Improvements

* optimize for large contexts with gzip compression and accurate token estimation ([16b57e3](https://github.com/pedrofariasx/qwenproxy/commit/16b57e3f62c0d8a1ec0eaa39da9d38f6d7077c2a))

## [1.3.3](https://github.com/pedrofariasx/qwenproxy/compare/v1.3.2...v1.3.3) (2026-06-10)


### Performance Improvements

* remove artificial random delay, increase warm pool, optimize TMD detection ([5610487](https://github.com/pedrofariasx/qwenproxy/commit/5610487a0a2df3c48add8d800fb4b8de4e77f582))

## [1.3.2](https://github.com/pedrofariasx/qwenproxy/compare/v1.3.1...v1.3.2) (2026-06-10)


### Performance Improvements

* reduce random delay and revert warm pool to lightweight headers ([1b28c07](https://github.com/pedrofariasx/qwenproxy/commit/1b28c07a30fb6b54477ed2d91772c1a5b5636278))

## [1.3.1](https://github.com/pedrofariasx/qwenproxy/compare/v1.3.0...v1.3.1) (2026-06-10)


### Bug Fixes

* add anti-detection stealth, full anti-fraud headers, and TMD challenge retry ([76d007f](https://github.com/pedrofariasx/qwenproxy/commit/76d007f1944501ff80c1c3f1ae9749ec82efbde2))

# [1.3.0](https://github.com/pedrofariasx/qwenproxy/compare/v1.2.3...v1.3.0) (2026-06-07)


### Bug Fixes

* **model-registry:** replace hardcoded models with live API data ([95e7f18](https://github.com/pedrofariasx/qwenproxy/commit/95e7f1859a1b70a34f180ae905b661a5d962771f))


### Features

* model-aware token estimation, dynamic timeouts, and robust JSON/tool-call parsing ([2d41378](https://github.com/pedrofariasx/qwenproxy/commit/2d41378edad60d612b1dfb08f16bf2e95eeb5064))

## [1.2.3](https://github.com/pedrofariasx/qwenproxy/compare/v1.2.2...v1.2.3) (2026-06-06)


### Bug Fixes

* handle double-escaped quotes and unclosed strings in tool call parser ([56f091f](https://github.com/pedrofariasx/qwenproxy/commit/56f091f9ef0844ff5443dcabd2bb95d158fb89a5))
* widen truncateMessages content type to accept object payloads ([de6f706](https://github.com/pedrofariasx/qwenproxy/commit/de6f7060cb5b3be2220260725c19e4d483ec648c))

## [1.2.2](https://github.com/pedrofariasx/qwenproxy/compare/v1.2.1...v1.2.2) (2026-06-05)


### Performance Improvements

* reduce per-chunk overhead in streaming hot path ([3fc85fa](https://github.com/pedrofariasx/qwenproxy/commit/3fc85fa697af782b4d260a6310b4a381aeb66a29))

## [1.2.1](https://github.com/pedrofariasx/qwenproxy/compare/v1.2.0...v1.2.1) (2026-06-05)


### Performance Improvements

* improve long-context reliability and warm pool latency ([6502bf2](https://github.com/pedrofariasx/qwenproxy/commit/6502bf26ea49880de1f7e22542db7b570bf1c34a))

# [1.2.0](https://github.com/pedrofariasx/qwenproxy/compare/v1.1.0...v1.2.0) (2026-06-04)


### Features

* add multimodal upload improvements and test suite ([06b9b6c](https://github.com/pedrofariasx/qwenproxy/commit/06b9b6cb5140eb064262f2867ffd7151277fcf53))

# [1.1.0](https://github.com/pedrofariasx/qwenproxy/compare/v1.0.0...v1.1.0) (2026-06-03)


### Bug Fixes

* rename package to @pedrofariasx/qwenproxy to resolve npm conflict ([31e0119](https://github.com/pedrofariasx/qwenproxy/commit/31e011914c278b1f9e2ec16cd12dd24a67356f1a))


### Features

* add bin entry for npx execution ([413c2cc](https://github.com/pedrofariasx/qwenproxy/commit/413c2ccfae50dfd4252acc38374460bb6b88791a))

# [1.1.0](https://github.com/pedrofariasx/qwenproxy/compare/v1.0.0...v1.1.0) (2026-06-03)


### Features

* add bin entry for npx execution ([413c2cc](https://github.com/pedrofariasx/qwenproxy/commit/413c2ccfae50dfd4252acc38374460bb6b88791a))

# 1.0.0 (2026-06-03)


### Bug Fixes

* add error classes, multi-response filter, stream_options, Not_Found to 404, update deps and README ([09cfee0](https://github.com/pedrofariasx/qwenproxy/commit/09cfee0ba9da972683545ce115a30e2feae74977))
* add UI login fallback and fix manual login browser visibility ([e6d2361](https://github.com/pedrofariasx/qwenproxy/commit/e6d2361ba3046782842972d8b2f7840ceb628baa))
* ajuste do nome do projeto para qwenproxy ([e1a6f20](https://github.com/pedrofariasx/qwenproxy/commit/e1a6f20fe3f751db68f4a0e9a0861fdba29dddaa))
* bypass Google login automated browser block during authentication ([57e9503](https://github.com/pedrofariasx/qwenproxy/commit/57e9503011cc789f1a864a0b426597b549e9e84f))
* cross-platform path handling and streaming parsing ([4eeb7f7](https://github.com/pedrofariasx/qwenproxy/commit/4eeb7f7c7f7caf8f268ced09495b0924d910756a))
* filter multi-response by response_id and map Not_Found to HTTP 404 ([e8f49c5](https://github.com/pedrofariasx/qwenproxy/commit/e8f49c5f1f082e3ea998af9ac816ac01310bce07))
* handle guest sessions and upstream errors ([cb3ea5c](https://github.com/pedrofariasx/qwenproxy/commit/cb3ea5cce501d02c5021d16352d34fcdfaa9e384))
* improve error handling, JSON parsing safety, and status code mapping ([18c5a15](https://github.com/pedrofariasx/qwenproxy/commit/18c5a151ddb672b1d13ba13a9351bbaa08b80c7f))
* improve error handling, JSON parsing, and retry logic per code review ([2ca0c4a](https://github.com/pedrofariasx/qwenproxy/commit/2ca0c4ae87204eef174c729065dd80271d8a1111))
* improve login reliability and exit code handling ([2e46403](https://github.com/pedrofariasx/qwenproxy/commit/2e464030e483151ee5a72866fcda42b488d42004))
* improve streaming parsing safety and path security ([b44c32f](https://github.com/pedrofariasx/qwenproxy/commit/b44c32f9c6343b6bd27284ffc380722f5df1a8ac))
* pre-create qwen_profiles directory and declare volume for Docker Swarm permissions ([38815ef](https://github.com/pedrofariasx/qwenproxy/commit/38815efa46007a65fabf974b244e9ddde5709478))
* preserve full message history ([0b0143b](https://github.com/pedrofariasx/qwenproxy/commit/0b0143b2fd5efdecf5b84ad62f305f05092e8229))
* rewrite Dockerfile for production Playwright environment ([340efaf](https://github.com/pedrofariasx/qwenproxy/commit/340efaf6406bd519c53de2495aa284a2e8905cff))
* support robust parsing of invalid backslash escape sequences in JSON ([86ea3f1](https://github.com/pedrofariasx/qwenproxy/commit/86ea3f13810fd20940dd00a7bea6f806c5131853))
* update CI release job to Node 22 for semantic-release compatibility ([9fc03d5](https://github.com/pedrofariasx/qwenproxy/commit/9fc03d50d3b017f24574adf3d17da6dcf501783d))


### Features

* add multimodal support and optimize upload header caching ([947d7fe](https://github.com/pedrofariasx/qwenproxy/commit/947d7fe5839953baa6bff913bdadb1e9874929ed))
* add route logging, network visibility, and multi-browser support ([aa277ce](https://github.com/pedrofariasx/qwenproxy/commit/aa277ce1c8fc8b943f4a7a7fc64bcdeaecb7a295))
* implement auto-login and session recovery ([700ca06](https://github.com/pedrofariasx/qwenproxy/commit/700ca061ca931a1ad655e214e17d1e5db9182f20))
* implement robust JSON parsing for tool calls and improve streaming stability ([e0f8664](https://github.com/pedrofariasx/qwenproxy/commit/e0f866444b7ff58334f5c3c58c7d2bc7d7c7df1e))
* implement robust tool validation and execution pipeline, fix import extensions, add ajv ([d4f3aa2](https://github.com/pedrofariasx/qwenproxy/commit/d4f3aa2ab69bcbdc9070d1809731a269846e5e69))
* improve OpenAI compatibility and robust JSON parsing ([7eb8699](https://github.com/pedrofariasx/qwenproxy/commit/7eb86996b50868d7c7a60ec563441eb154561cff))
* improve tool call parsing and consolidate tests ([7e3b92e](https://github.com/pedrofariasx/qwenproxy/commit/7e3b92ec1ea3c0f1957e090cb16fe56e01919f4a))
* integrate warm pool for faster Qwen chat initialization and header prefetching ([9499a4b](https://github.com/pedrofariasx/qwenproxy/commit/9499a4b0a31dfb1c0a4fa6948629827bc54beec8))
* migrate account storage from JSON to SQLite with WAL mode ([5905908](https://github.com/pedrofariasx/qwenproxy/commit/59059083c632a9252d40091d6fa0e25f2c886bc3))
* restore uuid for tool calls and add cloudflare heartbeat ([9b2f31c](https://github.com/pedrofariasx/qwenproxy/commit/9b2f31c088a8ea9e272ebde2f3e354dbdb40fdba))
* support multiple tool calls in array format ([22c3664](https://github.com/pedrofariasx/qwenproxy/commit/22c366478440de2e29d4db1aed46b66101eec0ae))


### Performance Improvements

* optimize models endpoint with account session and caching, and enhance SSE latency ([44a0a34](https://github.com/pedrofariasx/qwenproxy/commit/44a0a343a0313f6bd34a2983797134031ad6d022))
* optimize response speed and reliability ([0c0246c](https://github.com/pedrofariasx/qwenproxy/commit/0c0246ccbd75d15e23cc8d6ec82cee6ea726110c))
