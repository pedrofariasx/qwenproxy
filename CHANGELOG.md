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
