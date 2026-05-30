---
phase: 01-qwenproxy-hardening
plan: 01
revision: 1
type: execute
---

<goal>
GOAL: Transformar QwenProxy de "funcional com ressalvas" para "robusto, seguro e production-ready" — corrigindo bugs conhecidos, adicionando resiliência, melhorando segurança, e garantindo que rode de forma confiável como proxy OpenAI-compatible para Qwen.
</goal>

<objective>
Corrigir todas as fragilidades identificadas na análise inicial do QwenProxy e elevar a qualidade do código para padrão production-ready.

Purpose: O QwenProxy é um projeto bem arquitetado mas com pontos críticos: (1) middleware de API Key não protege todas as rotas, (2) interceptação de headers via Playwright é frágil com timeouts, (3) logging misturado entre Logger class e console.log, (4) sem validação de schema nos requests, (5) Dockerfile sub-otimizado, (6) sem rate limiting interno, (7) import crypto faltando em models.ts.

Output:
- Código corrigido com todos os bugs fechados
- Testes unitários passando (todos os test('...') em src/tests/)
- Playwright header interception mais resiliente
- Logger consistente em todo o código
- Validação de request com Zod
- Rate limiting interno (opcional, configurável)
- Dockerfile otimizado com multi-stage + healthcheck
- Roadmap documentado
</objective>

<context>
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/api/models.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/api/server.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/routes/chat.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/services/playwright.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/services/qwen.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/core/config.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/core/logger.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/core/account-manager.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/core/database.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/core/watchdog.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/core/metrics.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/tests/index.test.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/Dockerfile
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/.env.example
</context>

<claim>
CLAIM: Após aplicar este plano, o QwenProxy terá 100% dos testes unitários passando, todas as rotas protegidas por API Key, importações corretas, Logger consistente em todo o código, interceptação de headers mais resiliente com fallback, validação de request no chat, Dockerfile otimizado, e rate limiting opcional.
</claim>

<fastest_disproof_test>
FASTEST_DISPROOF_TEST: Rodar `npm test` e verificar TODOS os testes passando (estabelecer baseline de contagem exata ANTES das mudanças). Rodar `npx tsc --noEmit` e confirmar sem erros. Subir servidor e testar `/health`, `/v1/models` sem API Key (deve retornar 401).
</fastest_disproof_test>

<scope>
- in:
  - Corrigir middleware de API Key para proteger TODAS as rotas `/v1/*` (incluindo /v1/models E /v1/chat/completions — ambos registrados ANTES do middleware em server.ts)
  - Criar padrão de middleware: demarcar com comentário "ROTAS PROTEGIDAS POR API KEY ABAIXO DESTA LINHA" para evitar regressão futura
  - Adicionar `import crypto` em models.ts
  - Substituir console.log/error pelo Logger class em todo código (server, chat, playwright, qwen, account-manager, watchdog, etc.) usando grep exaustivo (`rg "console\.(log|warn|error)" src/`)
  - Adicionar validação de schema Zod para request body do `/v1/chat/completions`, com suporte a content como string OU array (multi-modal)
  - Fazer Playwright header interception mais resiliente: fallback de selectors, retry com reload, e screenshot de erro. CAPTCHA detection sera implementado na Fase 04.
  - Adicionar rate limiting configurável por IP (in-memory sliding window) — nota: x-forwarded-for é spoofable sem proxy reverso upstream
  - Otimizar Dockerfile com multi-stage build, healthcheck, non-root user — USAR `mcr.microsoft.com/playwright:v1.60.0-jammy` como base (NÃO Alpine)
  - Adicionar healthcheck endpoint mais informativo com timeout por fonte de dados
  - Corrigir todos os `console.log`/`console.error` para usar `logger.info`/`logger.error` (manter `console.error` apenas no entrypoint catch e app.onError)
  - Rodar typecheck e garantir que passa
  - Rodar testes e garantir que TODOS passam (estabelecer baseline de contagem exata ANTES das mudanças)
  - Documentar baseline: contar quantos testes passam antes das mudanças

- out:
  - Não vai substituir cache em memória por Redis (fica pra fases futuras, candidata Fase 05)
  - Não vai adicionar autenticação multi-usuário
  - Não vai reescrever o sistema de contas Qwen
  - Não vai adicionar suporte a WebSocket nativo
  - Não vai mudar a estratégia de login do Qwen (API + UI fallback)
  - Não vai adicionar cluster/sharding do Playwright
</scope>

<constraints>
- Zero mudança na API compatível com OpenAI (endpoints, formato de request/response)
- Não pode quebrar funcionalidade existente de streaming e non-streaming
- Não pode aumentar a latência média do chat em mais de 5ms
- Playwright interception deve continuar funcionando como fallback principal
- Deve manter suporte a múltiplas contas com round-robin
- Todo arquivo modificado deve ter typecheck passando
- Código deve continuar em TypeScript com tsx runtime
</constraints>

<non_goals>
- Não vamos portar para Bun ou Deno
- Não vamos adicionar testes de integração com Qwen real (já existem nos advanced tests)
- Não vamos refatorar o sistema de multi-account para gRPC ou message queue
- Não vamos adicionar UI web ou admin panel
- Não vamos substituir o sistema de cooldown por Redis
</non_goals>

<tasks>
<task type="auto">
  <name>Task 1: Corrigir middleware de API Key para proteger /v1/models E /v1/chat/completions</name>
  <files>src/api/server.ts</files>
  <action>
    Em server.ts, a ordem atual:
    1. app.route('', modelsApp)  ← registra /v1/models SEM auth
    2. app.post('/v1/chat/completions', ...)  ← TAMBÉM SEM auth
    3. app.post('/v1/chat/completions/stop', ...)  ← TAMBÉM SEM auth
    4. app.use('/v1/*', authMiddleware)  ← middleware chega DEPOIS das rotas
    
    No Hono, middleware registrado depois das rotas NÃO as intercepta.
    Solução: Mover `app.use('/v1/*', authMiddleware)` para ANTES de `app.route('', modelsApp)`.
    
    **Padrão obrigatório:** Adicionar comentário demarcatório:
    `// === ROTAS PROTEGIDAS POR API KEY (registre abaixo desta linha) ===`
    Isso cria um padrão visível para futuros desenvolvedores.
    
    **Teste adicional**: No test "API Key protection", adicionar verificação para `/v1/chat/completions` também (não só /v1/models).
  </action>
  <verify>Rodar o teste "API Key protection" — deve passar com 200 com key correta e 401 sem key em /v1/models E /v1/chat/completions.</verify>
  <done>Teste de API Key passa; curl sem Authorization retorna 401 em /v1/models e /v1/chat/completions</done>
</task>

<task type="auto">
  <name>Task 2: Adicionar import crypto em models.ts</name>
  <files>src/api/models.ts</files>
  <action>
    Adicionar `import crypto from 'node:crypto'` no topo do arquivo. O `crypto.randomUUID()` é usado mas sem import — funciona porque Node expõe globalmente, mas é má prática e quebra em runtimes mais estritos.
  </action>
  <verify>npx tsc --noEmit não aponta erro de crypto não encontrado</verify>
  <done>crypto import adicionado, typecheck passa sem warnings</done>
</task>

<task type="auto">
  <name>Task 3: Migrar console.log/error para Logger class</name>
  <files>src/api/server.ts, src/routes/chat.ts, src/services/playwright.ts, src/services/qwen.ts, src/core/account-manager.ts, src/core/database.ts, src/login.ts, src/core/metrics.ts, src/core/watchdog.ts</files>
  <action>
    Em vez de `console.log(...)` e `console.error(...)`, usar o Logger class já existente em `src/core/logger.ts`. Estratégia:
    - Cada módulo ganha seu próprio logger via `const logger = new Logger('info', 'Server')` ou similar
    - Substituir `console.log(...)` → `logger.info(...)`
    - Substituir `console.warn(...)` → `logger.warn(...)`
    - Substituir `console.error(...)` → `logger.error(...)`
    - Manter `console.error` apenas no entrypoint `src/index.ts` (catch global) e no `app.onError` do Hono
    - Garantir que o nível `LOG_CONSOLE` do config seja consistente
  </action>
  <verify>Servidor sobe e exibe logs formatados com timestamp e nível (INFO, WARN, ERROR) em vez de console.log puro</verify>
  <done>Todos os módulos usam Logger; console.log/error permanece APENAS em index.ts (catch global) e app.onError</done>
</task>

<task type="auto">
  <name>Task 4: Adicionar validação de schema Zod para chat completions request</name>
  <files>src/types/validation.ts (novo), src/routes/chat.ts</files>
  <action>
    Adicionar validação do body do request `/v1/chat/completions` usando Zod:
    - Criar `src/types/validation.ts` com schema Zod
    - Validar que `messages` é array não vazio com role e content
    - **CRÍTICO:** `content` deve aceitar `string | Array<{type: string, ...}>` — NÃO restringir a string apenas, pois mensagens multi-modal (vision, áudio) usam `content: [{type: "text", text: "..."}, {type: "image_url", ...}]`
    - Validar que `model` é string não vazia
    - Validar tipos de `stream` (boolean opcional)
    - Validar `tools` (array opcional de function tools)
    - Validar `tool_choice` (opcional)
    - Validar `max_tokens` (number opcional)
    - Validar `temperature` (number opcional)
    - Validar `top_p` (number opcional)
    - Validar `stop` (string | string[] opcional)
    - Validar `stream_options` (opcional)
    - Validar `response_format`, `seed`, `frequency_penalty`, `presence_penalty`, `logit_bias`, `n`, `user` como opcionais (NÃO rejeitar parâmetros desconhecidos)
    - Retornar 400 com mensagem clara se inválido (formato padronizado OpenAI)
  </action>
  <verify>Enviar request inválido (sem messages) → 400 com erro descritivo no formato OpenAI padrão</verify>
  <done>Validação Zod implementada; requests inválidos retornam 400 com detalhes; testes unitários existentes continuam passando</done>
</task>

<task type="auto">
  <name>Task 5: Tornar Playwright header interception mais resiliente</name>
  <files>src/services/playwright.ts</files>
  <action>
    Melhorar a resiliência do `_getQwenHeadersInternal`:
    1. Extrair selectors de botão de envio para constante no topo do arquivo
    2. Adicionar mais selectors de fallback: `button[data-testid="send"]`, `button[aria-label*="send"]`, `.chat-footer button`, `button.submit`
    3. Se o clique no botão falhar (não disparou a rota), tentar Enter key + delay de 1s
    4. CAPTCHA detection sera implementado na Fase 04 — esta task adiciona apenas fallback de selectors, retry com reload e screenshot de erro.
    5. Se o timeout de 60s no header interception for atingido (SEM CAPTCHA detectado), fazer 1 retry com `page.reload()` + re-aplicação do route handler (com cuidado para não corromper o mutex: liberar e readquirir antes do reload)
    6. Se ainda falhar (sem CAPTCHA), levantar erro claro: "Qwen UI change — header interception failed after retry"
    7. Adicionar logging com logger.info/warn/error em cada passo do processo
    8. Salvar screenshot de erro em `/tmp/` (não em qwen_profiles/) para compatibilidade com Docker
  </action>
  <verify>Logs indicam qual caminho foi usado para disparar a interceptação (botão X, Enter, etc.). Se CAPTCHA detectado, aborta sem reload.</verify>
  <done>Header interception tem no mínimo 5 selectors de fallback + 1 retry com reload (apenas se SEM CAPTCHA) + logging por passo</done>
</task>

<task type="auto">
  <name>Task 6: Adicionar rate limiting configurável</name>
  <files>src/core/rate-limiter.ts (novo), src/core/config.ts, src/api/server.ts</files>
  <action>
    Implementar rate limiting simples in-memory com sliding window:
    - Criar `src/core/rate-limiter.ts` com classe `RateLimiter`
    - Algoritmo: sliding window counters (precisa, eficiente em memória)
    - Config: `RATE_LIMIT_ENABLED=false`, `RATE_LIMIT_MAX=60`, `RATE_LIMIT_WINDOW_MS=60000`
    - Usar `x-forwarded-for` header ou IP direto como chave
    - ⚠️ AVISO: `x-forwarded-for` é spoofable se o proxy estiver exposto diretamente à internet sem proxy reverso (nginx, Cloudflare). Documentar que em produção é obrigatório um reverse proxy upstream.
    - **IMPORTANTE:** Se usado atrás de Cloudflare, o header correto é `cf-connecting-ip`. Para suporte genérico a proxies confiáveis, o rate limiter deve aceitar configuração de qual header usar via `RATE_LIMIT_HEADER=x-forwarded-for`.
    - Retornar 429 no formato OpenAI-compatible: `{ error: { message: "Rate limit exceeded", type: "rate_limit_error" } }`
    - Headers: Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
    - Opcional e desligado por padrão (não quebra nada existente)
    - Integrar como middleware Hono via `app.use('/v1/*', rateLimitMiddleware)` atrás da flag
    - Adicionar cleanup periódico das chaves expiradas
  </action>
  <verify>RATE_LIMIT_ENABLED=true + RATE_LIMIT_MAX=5 + 6 requests → 429 no 6º com headers de rate limit</verify>
  <done>Rate limiter implementado, configurado via .env, desligado por padrão, sem impacto em testes existentes</done>
</task>

<task type="auto">
  <name>Task 7: Otimizar Dockerfile (multi-stage + healthcheck)</name>
  <files>Dockerfile, docker-compose.yml, .dockerignore</files>
  <action>
    **Estado atual do Dockerfile:** JÁ usa `mcr.microsoft.com/playwright:v1.60.0-jammy` como base e JÁ roda como non-root (USER pwuser). Apenas adicionar o que está faltando:
    - **Multi-stage build:** stage 1 (build) instala dependências; stage 2 (runtime) copia apenas node_modules --production + src. **⚠️ ATENÇÃO:** multi-stage com Playwright é complexo porque as libs do Chromium (libnss3, libnspr4, libatk, libcups, libdrm, libxkbcommon) precisam estar no stage final. Usar a mesma imagem base em ambos stages para simplificar (`mcr.microsoft.com/playwright:v1.60.0-jammy`).
    - **HEALTHCHECK** com `curl` ou `wget` no /health
    - **.dockerignore** com node_modules, .git, data/, qwen_profiles/, *.md, .env
    - **docker-compose.yml** com healthcheck, restart: unless-stopped, volumes para data/ e qwen_profiles/
  </action>
  <verify>docker build passa sem erros; docker compose up inicia e healthcheck responde</verify>
  <done>Dockerfile otimizado com multi-stage, healthcheck, non-root</done>
</task>

<task type="auto">
  <name>Task 8: Melhorar endpoint /health</name>
  <files>src/api/server.ts</files>
  <action>
    Enriquecer o /health check:
    - Retornar status do Playwright (lastHeadersTime, account conectado)
    - Retornar status das contas (total, em cooldown)
    - Retornar uptime do servidor (variável startTime)
    - Retornar versão do app (import do package.json)
    - Usar HTTP 200 se healthy, 503 se watchdog unhealthy
    - **Timeout por fonte de dados:** cada verificação (Playwright, accounts, watchdog) deve ter timeout individual (3s) para evitar que health endpoint trave. Nunca fazer page.evaluate() dentro do health check
    - Manter /health intencionalmente sem autenticação (monitoramento precisa acessar)
    - NOTA: /health endpoint é registrado no Hono antes do middleware de auth, então fica intencionalmente desprotegido — documentar com comentário
  </action>
  <verify>curl /health retorna JSON com uptime, version, playwright_status, accounts_status, watchdog_status</verify>
  <done>Health endpoint expandido com informações úteis para monitoramento</done>
</task>

<task type="auto">
  <name>Task 9: Atualizar .env.example com todas as variáveis</name>
  <files>.env.example</files>
  <action>
    Adicionar documentação no .env.example para todas as variáveis de ambiente, incluindo as novas:
    - Agrupar por categoria: Server, Browser, Timeouts, Cache, Metrics, Watchdog, Rate Limiting
    - Adicionar comentários explicativos em cada variável
    - Incluir defaults
    - Adicionar seção de exemplo de uso
  </action>
  <verify>.env.example tem todas as variáveis do config.ts documentadas com comentários</verify>
  <done>.env.example completo + categorizado + comentários + defaults + exemplos</done>
</task>

<task type="auto">
  <name>Task 10: Timing-safe API key + env var validation</name>
  <files>src/api/server.ts, src/core/config.ts</files>
  <action>
    Duas correções de segurança no servidor:

    1. **Timing-safe comparison**: Substituir `token !== apiKey` por `crypto.timingSafeEqual()`:
       - Antes, verificar se ambos os buffers têm o mesmo length (se não, rejeitar sem comparar)
       - Criptografar usando Buffer.from() para garantir UTF-8 consistente
    2. **EnV validation**:
       - Adicionar validação que API_KEY não pode ser vazia (warning na inicialização)
       - Adicionar QWEN_EMAIL e QWEN_PASSWORD ao Zod schema do config.ts (atualmente lidos direto de process.env em playwright.ts)
    3. **Import crypto**: se necessário, adicionar `import crypto from 'node:crypto'` no server.ts
  </action>
  <verify>"API Key protection" test passa. curl sem Authorization → 401 sem timing information. Servidor loga warning se API_KEY vazia.</verify>
  <done>Timing-safe comparison implementado; env vars validadas; QWEN_EMAIL/PASSWORD no config schema</done>
</task>

<task type="auto">
  <name>Task 11: Error sanitization (safe error messages)</name>
  <files>src/api/server.ts, src/routes/chat.ts</files>
  <action>
    Erros internos (stack traces, detalhes de implementação) NÃO devem vazar para o cliente:

    1. **App.onError** (server.ts:62): substituir por lógica que em produção retorna mensagem genérica "Internal server error"
    2. **chat.ts catch** (linha 752): mesmo padrão
    3. **Criar helper** `sanitizeError(err, isProd)`:
       - Erros conhecidos (QwenUpstreamError, RetryableQwenStreamError) mantêm mensagem
       - Erros desconhecidos em produção: mensagem genérica
       - Em dev (NODE_ENV !== 'production'): incluir detalhes

    Adicionar NODE_ENV como variável de ambiente documentada no .env.example.
  </action>
  <verify>NODE_ENV=production → erro interno retorna "Internal server error". NODE_ENV=dev → stack trace visível.</verify>
  <done>Error sanitization implementado; mensagens seguras em produção; detalhes em dev</done>
</task>

<task type="auto">
  <name>Task 12: Input size limits na validacao Zod</name>
  <files>src/types/validation.ts</files>
  <action>
    Expandir a validacao Zod (Task 4) com limites de seguranca:

    1. **messages**: adicionar `.max(200, "Too many messages (max 200)")` — 100 e pouco para conversas multi-turn com exemplos few-shot. Tornar MAX_MESSAGES=200 configuravel via env var no config.ts.
    2. **content string**: cada mensagem nao pode exceder 50000 chars
    3. **tools**: maximo 50 tools por request
    4. **model**: string nao pode exceder 200 chars

    Retornar 400 padrao se exceder os limites.
    Garantir que os testes existentes NAO sao afetados.

    Adicionar middleware Hono que rejeita requests com Content-Length excedendo MAX_REQUEST_BODY_BYTES=10485760 (configuravel). Isso evita DoS por body gigante antes mesmo do JSON parser rodar. Documentar no .env.example como MAX_REQUEST_BODY_BYTES.
  </action>
  <verify>POST com 101 mensagens → 400 "Too many messages". POST com content de 60000 chars → 400.</verify>
  <done>Input size limits implementados no Zod schema; testes existentes continuam passando</done>
</task>

<task type="auto">
  <name>Task 13: Security headers middleware</name>
  <files>src/api/server.ts</files>
  <action>
    Adicionar middleware Hono que seta security headers em TODAS as respostas:
    ```
    X-Content-Type-Options: nosniff
    X-Frame-Options: DENY
    X-XSS-Protection: 1; mode=block
    Strict-Transport-Security: max-age=31536000 (SEMPRE — SSL_ENABLED nao existe ate a Fase 04, implementar incondicionalmente aqui e revisar na Fase 04)
    Cache-Control: no-store (para /v1/*)
    ```
    Implementar como middleware separado, registrado PRIMEIRO (antes de qualquer rota).
    Nao usar helmet (dependencia externa) — headers sao simples o suficiente para implementar manualmente.
  </action>
  <verify>curl -I localhost:3000/health → response inclui X-Content-Type-Options, X-Frame-Options, X-XSS-Protection</verify>
  <done>Security headers implementados em todas as respostas; sem dependencias externas</done>
</task>

<task type="auto">
  <name>Task 14: Graceful shutdown timeout + MemoryCache eviction</name>
  <files>src/api/server.ts, src/cache/memory-cache.ts</files>
  <action>
    Duas correcoes de resiliencia:

    1. **Shutdown timeout** (server.ts): o shutdown atual chama Playwright.close(), database.close(), cache.close() sem timeout. Adicionar Promise.race com timeout de 10s. Se exceder, forcar process.exit(1).
    2. **MemoryCache eviction** (cache/memory-cache.ts): o cache atual nao tem limite de crescimento. Adicionar CACHE_MAX_ENTRIES=10000. Quando o limite e excedido, remover entradas expiradas primeiro (TTL), depois as mais antigas (LRU aproximado por insercao).

    Config:
    - SHUTDOWN_TIMEOUT_MS=10000
    - CACHE_MAX_ENTRIES=10000 (default)
  </action>
  <verify>MemoryCache com 10001+ entries → a mais antiga e removida. Shutdown nao trava mais que 10s.</verify>
  <done>Graceful shutdown timeout implementado; MemoryCache com LRU eviction; configuravel</done>
</task>
</tasks>

<done_when>
- [ ] `npx tsc --noEmit` passa sem erros
- [ ] `npm test` passa com TODOS os testes (incluindo API Key protection)
- [ ] Servidor sobe e health endpoint retorna informações úteis
- [ ] Requests inválidos retornam 400 com validação Zod
- [ ] Rotas /v1/* sem API Key retornam 401
- [ ] Rate limiting funcional quando ativado (desligado por padrão)
- [ ] Dockerfile multi-stage compila sem erros
- [ ] Todos os módulos usam Logger class em vez de console.log/error
- [ ] .env.example documenta todas as variáveis
- [ ] Playwright header interception com fallback de selectors + retry
- [ ] Logger migration preserva `console.error` em index.ts (catch) e app.onError (conferido por `grep -rn "console\.error\|console\.log\|console\.warn" src/ --include="*.ts" --exclude-dir=tests` — SÓ deve aparecer em index.ts)
- [ ] Baseline documentado: ANTES das mudanças, rodar `npm test 2>&1 | tail -20` e registrar QUANTOS testes existem e quantos passam
- [ ] Timing-safe comparison implementado (crypto.timingSafeEqual)
- [ ] Error sanitization ativa (erros internos nao vazam em producao)
- [ ] Input size limits no Zod (messages <=100, content <=50k chars)
- [ ] Security headers em todas as respostas
- [ ] MemoryCache eviction funcional (LRU + TTL)
- [ ] Shutdown timeout <10s (nao trava infinitamente)
- [ ] Body size limit middleware ativo (MAX_REQUEST_BODY_BYTES)
- [ ] Performance baseline registrado em /tmp/baseline-latency.txt
</done_when>

<stop_if>
- [ ] TypeScript typecheck falhar após correções
- [ ] Teste de API Key continuar falhando após correção do middleware
- [ ] Servidor não subir após mudanças
- [ ] Streaming quebrar (regressão não detectada por testes)
- [ ] Playwright header interception parar de funcionar completamente (sem fallback funcional)
- [ ] Qualquer mudança que altere o formato de resposta da API OpenAI-compatible
- [ ] Dockerfile multi-stage não compilar
- [ ] Regressão de performance >5ms por request (medir com "ab -n 50 http://localhost:3000/health" antes e depois — registrar baseline em /tmp/baseline-latency.txt)
- [ ] Zod schema rejeitar request multi-modal válido (content como array)
- [ ] Logger migration causar crash na inicialização (import error)
- [ ] Rate limiter bloqueando requests quando desligado (RATE_LIMIT_ENABLED=false)
- [ ] Error sanitization vazar stack trace em producao (NODE_ENV=production)
- [ ] Rate limiter cleanup timer falha silenciosamente
- [ ] Body gigante alem de 10MB ultrapassa limite
</stop_if>

<checkpoints>
- [ ] Checkpoint 1 (Tasks 1-2): typecheck + teste API Key protection passa
- [ ] Checkpoint 2 (Task 3): servidor sobe com logs formatados pelo Logger
- [ ] Checkpoint 3 (Tasks 4-5): validação + Playwright resilience — testes passam
- [ ] Checkpoint 4 (Task 6): rate limiter funcional e desligado por padrão
- [ ] Checkpoint 5 (Tasks 7-9): Docker compila, health endpoint rico, .env.example completo
- [ ] Checkpoint 6 (Tasks 10-11): timing-safe + sanitization — tests passam
- [ ] Checkpoint 7 (Tasks 12-14): input limits + security headers + cache eviction — servidor funcional
- [ ] Checkpoint 8: Revisao final integrada — todos os testes + typecheck + servidor OK
</checkpoints>

<validation>
- minimum: `npx tsc --noEmit` + `npm test` + servidor sobe
- gate: Teste manual completo:
  1. `curl -X POST localhost:3000/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"qwen-plus","messages":[{"role":"user","content":"hi"}]}'` ← sem API Key → 401
  2. Health endpoint retorna JSON completo com uptime, version, accounts
  3. Request inválido sem messages → 400
  4. Rate limiting com flag ativada → 429 após N requests
  5. Docker build + compose up → healthcheck OK
</validation>

<rollback>
- trigger: Qualquer STOP_IF acionado ou checkpoint não atingido em 2 tentativas
- action: `git diff --name-only > /tmp/qwenproxy-rollback-01-paths.txt && for f in $(cat /tmp/qwenproxy-rollback-01-paths.txt); do git checkout HEAD -- "$f" 2>/dev/null; done` para reverter APENAS arquivos modificados nesta fase. **NÃO usar `git checkout -- .` ou `git clean -fd`** — isso destruiria mudanças de fases anteriores. Remover novos arquivos não rastreados desta fase manualmente com `rm -f src/types/validation.ts src/core/rate-limiter.ts`. Revisar o plano e ajustar.
</rollback>

<owners>
- owner: Claude Code (franc)
- next: `plan-loop --mode autonomous_fix --max-iterations 3 --profile auto`
</owners>

<success_criteria>
- Explicit GOAL
- Explicit CLAIM
- Measurable FASTEST_DISPROOF_TEST
- VECTOR_OPPORTUNITY: N/A — QwenProxy é um proxy stateless sem corpus/retrieval/vector/cache adapters. Melhorias de cache (Redis etc.) estão fora de escopo nesta fase.
- Clear scope in/out
- Objective DONE_WHEN
- Objective STOP_IF
- Verifiable checkpoints
- Defined validation ladder
- Explicit rollback and handoff
</success_criteria>
</phase>
