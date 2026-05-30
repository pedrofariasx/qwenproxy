---
phase: 04-security-reliability-hardening
plan: 04
revision: 1
type: execute
---

<goal>
GOAL: Elevar QwenProxy de "segurança básica funcional" para "padrão de segurança defensiva e resiliência operacional" — corrigindo vetores de ataque, vazamentos de informação, riscos de memória, e gaps de observabilidade que nenhuma fase anterior cobre.
</goal>

> **⚠️ DEPENDÊNCIA:** Esta fase DEVE ser executada APÓS as Fases 01, 02 e 03. Assume que o código já está com logger, tipos, validação Zod e tool calling corrigidos. Fase 04 é uma camada de hardening adicional em cima do código já estabilizado.

<objective>
A análise multi-especialista de 6 revisores (Critic, Proxy/Network, AI/LLM Engineer, Security Auditor, TS Architect, DevOps/SRE) identificou 20+ gaps que não estavam cobertos pelas fases 01-03. Esta fase fecha todos eles: segurança ofensiva (timing attacks, prompt injection), resiliência operacional (memory leaks, race conditions), observabilidade (métricas, logging estruturado), e produção (Docker, backups).

Output:
- CAPTCHA detection multi-camada (iframe + script + URL) para Cloudflare Turnstile
- Prometheus histogram formatado corretamente
- npm audit integrado ao workflow
- Request ID tracking ponta-a-ponta
- ToolHandler types reconciliados na Fase 03 (pre-requisito)
- Per-tool-call timeout no ExecutionLoop
- Login flow com comportamento human-like
- /metrics endpoint protegido por auth
- Senhas criptografadas no SQLite
- TLS opcional nativo
- Dependências chat.ts entre fases resolvidas
</objective>

<context>
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/services/playwright.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/core/metrics.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/core/config.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/core/database.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/tools/executor.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/tools/types.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/types/openai.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/api/server.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/routes/chat.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/package.json
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/.github/workflows
</context>

<claim>
CLAIM: Após aplicar este plano, o QwenProxy terá CAPTCHA detection multi-camada, métricas Prometheus válidas, npm audit no CI, request ID tracking, ToolHandler types consistentes, timeouts por tool call, login human-like, /metrics protegido, senhas criptografadas em repouso, TLS opcional, e dependências chat.ts resolvidas.
</claim>

<fastest_disproof_test>
FASTEST_DISPROOF_TEST: Rodar `npm test` — todos os testes passam. Rodar `curl localhost:3000/metrics` sem API Key → retorna texto Prometheus com histogramas em formato válido. Rodar `npx tsc --noEmit`. Verificar que `! grep -q "token [!=]= apiKey" src/api/server.ts` tem zero ocorrências de `token !== apiKey` (substituído por timingSafeEqual).
</fastest_disproof_test>

<scope>
- in:
  - CAPTCHA detection multi-camada: iframe + script tag + URL check + window.turnstile
  - Prometheus histogram format correction
  - npm audit + dependency scanning no CI
  - Request ID propagation via x-request-id header
  - ToolHandler type reconciliation (genéricos vs concretos) ANTES da unificação
  - Per-tool-call timeout (default 30s) no ExecutionLoop + registry.execute()
  - Login flow com delays randomizados + typing patterns human-like
  - /metrics endpoint com auth (mesma API Key)
  - Senhas criptografadas no SQLite (AES-256-GCM)
  - TLS opcional nativo (SSL_CERT_PATH, SSL_KEY_PATH)
  - Cross-phase chat.ts dependency resolution documentada
  
- out:
  - Não vai adicionar autenticação multi-fator
  - Não vai implementar Web Application Firewall
  - Não vai adicionar SSO/OAuth
  - Não vai substituir SQLite por PostgreSQL
  - Não vai adicionar auditoria de acesso (audit log)
  - Não vai implementar rede de confiança zero (zero trust)
</scope>

<constraints>
- Zero mudança na API wire do OpenAI
- Não pode quebrar testes existentes
- TLS deve ser opcional (desligado por padrão, compatível com reverse proxy)
- Criptografia de senhas deve ser backward-compatible com dados existentes
- Login human-like não pode aumentar latência de login em mais de 10s
- npm audit não pode falhar em CVEs não resolvíveis (apenas alertar)
</constraints>

<non_goals>
- Não vamos adicionar intrusion detection
- Não vamos implementar HSMs
- Não vamos fazer hardening de rede (firewall rules, etc.)
- Não vamos certificar para padrões (SOC2, ISO 27001)
- Não vamos adicionar rate limiting por tool call
</non_goals>

<tasks>

<task type="auto">
  <name>Task 1: CAPTCHA detection multi-camada (Turnstile)</name>
  <files>src/services/playwright.ts</files>
  <action>
    Substituir a detecção de CAPTCHA baseada apenas em iframes por abordagem multi-camada:
    
    1. **IFrame check**: `<iframe[^>]*src=["'].*challenges\.cloudflare\.com` e `recaptcha\.api\.google\.com` e `hcaptcha`
    2. **Script tag check**: `<script[^>]*src=["'].*challenges\.cloudflare\.com` e `recaptcha/api\.js` e `hcaptcha\.com/1/api\.js`
    3. **URL redirect check**: após `page.goto()`, monitorar se URL contém `/cdn-cgi/`, `/challenge`, `/block`
    4. **window object check**: via `page.evaluate(() => !!(window as any).turnstile || !!(window as any).grecaptcha)` — detecta invisible Turnstile
    
    Executar checagem em 3 momentos:
    - Antes de interagir com a página (pós-navegação)
    - Antes do clique no botão de envio (a página pode ter carregado o desafio depois)
    - Após timeout sem headers (CAPTCHA pode ter aparecido durante a espera)
    
    Se CAPTCHA detectado em QUALQUER camada:
    - Logar erro estruturado: `CAPTCHA detected via <method>`
    - Expor estado no health endpoint: `playwright.captcha_detected: true`
    - NÃO fazer reload (reload re-triggers o CAPTCHA)
    - Abortar com exceção clara
  </action>
  <verify>Playwright detecta CAPTCHA em todas as 4 modalidades (iframe, script, URL, window). Se um dos métodos falhar, os outros compensam.</verify>
  <done>CAPTCHA detection multi-camada implementada; invisível + visível; health endpoint expõe estado</done>
</task>

<task type="auto">
  <name>Task 2: Corrigir formato Prometheus histograma</name>
  <files>src/core/metrics.ts</files>
  <action>
    `formatPrometheus()` atualmente serializa histogram values como `point.value` (um objeto JS `{count, sum, buckets}`) diretamente em string, o que produz formato Prometheus INVÁLIDO.
    
    Corrigir para output correto:
    ```
    # TYPE requests_latency histogram
    requests_latency_bucket{le="0.005"} 12
    requests_latency_bucket{le="0.01"} 45
    requests_latency_bucket{le="0.025"} 120
    requests_latency_bucket{le="0.05"} 234
    requests_latency_bucket{le="0.1"} 456
    requests_latency_bucket{le="0.25"} 789
    requests_latency_bucket{le="0.5"} 1024
    requests_latency_bucket{le="1"} 1500
    requests_latency_bucket{le="+Inf"} 2000
    requests_latency_sum 123.456
    requests_latency_count 2000
    ```
    
    Além disso:
    - Adicionar métrica `up 1` (liveness)
    - Adicionar `build_info{version="x.y.z", commit="abc123"}` (info gauge)
    - Cache O(n) nas métricas de cache stats (não iterar todos os entries no health check)
  </action>
  <verify>curl localhost:3000/metrics retorna histogramas em formato Prometheus válido (parseável por promtool check metrics)</verify>
  <done>Prometheus histogram formatado corretamente; build_info e up adicionados; cache stats otimizado</done>
</task>

<task type="auto">
  <name>Task 3: Integrar npm audit + dependency scanning</name>
  <files>package.json, .github/workflows (criar se não existir)</files>
  <action>
    Adicionar verificações de segurança de dependências:
    
    1. **npm audit**: adicionar script no package.json: `"audit": "npm audit --audit-level=high"`
    2. **CI workflow**: criar `.github/workflows/security.yml` com:
       - `npm audit` em todo PR
       - Verificação de lockfile integrity
       - Escaneamento com `npm audit --json` (não falhar em CVEs não resolvíveis — apenas warning)
    3. **Pre-commit hook** (opcional, documentar): instruções para husky/lint-staged
    4. **Documentar** no README: seção de segurança listando `npm audit` como prática recomendada
    
    ⚠️ Tratar com cuidado: `npm audit` pode reportar CVEs sem fix disponível. O CI deve alertar mas não bloquear nesses casos.
  </action>
  <verify>npm run audit executa sem erros fatais; .github/workflows/security.yml existe com os steps</verify>
  <done>npm audit integrado; CI workflow criado; dependências monitoradas</done>
</task>

<task type="auto">
  <name>Task 4: Request ID tracking ponta-a-ponta</name>
  <files>src/api/server.ts, src/core/logger.ts</files>
  <action>
    Implementar propagação de request ID para correlação de logs:
    
    1. **Middleware Hono**: antes de qualquer outra rota, gerar ou propagar `x-request-id`
       - Se cliente enviou `X-Request-Id`, usar esse valor (idempotência)
       - Se não, gerar UUID v4
       - Armazenar em `c.set('requestId', id)` e setar no response header
    2. **Logger**: usar `logger.withRequestId(id)` (já implementado na Fase 03 Task 8) integrado ao requestId do middleware — o método retorna uma instância do logger com o ID incluído em toda linha
    3. **Métricas**: adicionar label `request_id` nas métricas de latency (ou alternativa: usar `completionId` como correlator)
    4. **Chat completion**: o `completionId` gerado (`chatcmpl-xxxx`) deve ser logado junto com request ID
    
    Formato de log com request ID:
    ```
    [2026-05-30T10:00:00.000Z] [INFO] [req_abc123] [Chat] Routing request to account: user@email.com
    ```
    **VALIDACAO X-Request-Id:** Validar formato: alfanumerico, hifens, underscores, dots apenas, max 64 chars. IDs invalidos geram novo UUID silenciosamente (nao rejeitar com 400 para nao quebrar clientes legitimos).
  </action>
  <verify>curl -H "X-Request-Id: test-123" localhost:3000/health → response header x-request-id: test-123. Logs incluem request ID.</verify>
  <done>Request ID tracking implementado; logs correlacionáveis; metrics com request context</done>
</task>


<task type="auto">
  <name>Task 6: Per-tool-call timeout + argument size limits</name>
  <files>src/tools/executor.ts, src/tools/registry.ts</files>
  <action>
    O ExecutionLoop atual não tem limites por tool call individual. Adicionar:
    
    1. **Timeout por tool call**: `registry.execute()` aceitar `AbortSignal` opcional. Default 30s por tool call via `AbortSignal.timeout(30000)`.
    2. **Argument size limit**: validar que `JSON.stringify(tc.arguments).length < 1MB` antes de executar. Se exceder, retornar erro sem executar.
    3. **Result size limit**: validar que o resultado da tool não excede 512KB. Se exceder, truncar com warning.
    **Budget total:** Adicionar EXECUTOR_TOTAL_ARGUMENTS_BYTES=10485760 (10MB default) acumulado em todas as turns. Se excedido, abortar o loop.
    
    Config:
    - `TOOL_TIMEOUT_MS=30000`
    - `TOOL_MAX_ARGUMENTS_BYTES=1048576`
    - `TOOL_MAX_RESULT_BYTES=524288`
    
    Integrar com `EXECUTOR_TIMEOUT_MS` já existente: per-tool timeout é o timeout máximo para UMA tool, EXECUTOR_TIMEOUT_MS é o timeout total de todo o loop.
  </action>
  <verify>Tool que demora >30s retorna erro de timeout. Argumento >1MB rejeitado antes da execução.</verify>
  <done>Per-tool-call timeout implementado; argument/result size limits ativos; budget total respeitado</done>
</task>

<task type="auto">
  <name>Task 7: Login flow human-like behavior</name>
  <files>src/services/playwright.ts</files>
  <action>
    O login flow atual (loginToQwen, loginToQwenUI) faz form filling sem delays — detectável como bot por Qwen.
    
    Adicionar:
    1. **Typing delays randomizados**: 100-300ms por caractere, com variação normal (Gaussian)
    2. **Mouse movements**: antes de clicar, mover mouse para posição aleatória próxima ao botão
    3. **Delay entre campos**: após preencher email, esperar 500-1500ms antes de preencher password
    4. **Delay antes do submit**: após preencher tudo, esperar 300-2000ms antes de clicar
    
    Implementar como helper `humanLikeType(page, selector, text)` e `humanLikeClick(page, selector)` que encapsulam esses comportamentos.
    
    ⚠️ Delay adicional total não deve exceder 10s somando todos os fatores.
  </action>
  <verify>Login flow executa com delays visíveis (~3-8s adicionais). Qwen não bloqueia por automated behavior detection.</verify>
  <done>Login flow human-like implementado; delays randomizados; Qwen não detecta automação</done>
</task>

<task type="auto">
  <name>Task 8: Proteger /metrics endpoint com API Key</name>
  <files>src/api/server.ts</files>
  <action>
    O endpoint `/metrics` atualmente não tem autenticação (server.ts:53-57). Qualquer um que acesse a porta do servidor pode ver métricas operacionais detalhadas.
    
    Adicionar auth middleware para `/metrics` usando a mesma API Key:
    - Se `API_KEY` está configurada, `/metrics` requer `Authorization: Bearer <API_KEY>`
    - Se `API_KEY` está vazia (não configurada), `/metrics` fica aberto (compatibilidade dev)
    
    Implementar como middleware específico para `/metrics` (não usar o `app.use('/v1/*')` pois /metrics não é /v1/).
    
    Manter `/health` SEM autenticação (monitoring tools precisam acesso sem key).
  </action>
  <verify>curl localhost:3000/metrics sem API Key → 401. curl com API Key → texto Prometheus. curl localhost:3000/health → sempre 200.</verify>
  <done>/metrics endpoint protegido por API Key; /health permanece público</done>
</task>

<task type="auto">
  <name>Task 9: Criptografar senhas no SQLite</name>
  <files>src/core/database.ts, src/core/accounts.ts</files>
  <action>
    Senhas das contas Qwen são armazenadas em plaintext no SQLite (`database.ts:36`). Adicionar criptografia em repouso:
    
    1. **Chave de criptografia**: derivada de `QWEN_ENCRYPTION_KEY` (nova env var, 32 bytes hex) via `crypto.pbkdf2Sync(key, randomSalt, 100000, 32, "sha512")`
    2. **Algoritmo**: AES-256-GCM com IV aleatório de 12 bytes + auth tag de 16 bytes
    3. **Formato**: `{iv}:{authTag}:{encryptedData}` tudo em base64
    4. **Migration**: ao iniciar, verificar se senhas existentes começam com `{iv}:` (já criptografadas) ou não (plaintext). Se plaintext, criptografar na inicialização.
    5. **Falha segura**: se `QWEN_ENCRYPTION_KEY` não estiver definida, logar WARNING e continuar com plaintext (backward compatibility)
    6. **Salt storage**: Armazenar o salt junto com IV+ciphertext+authTag. Documentar que QWEN_ENCRYPTION_KEY deve ter no minimo 128-bit de entropia.
    
    ⚠️ NOTA: SHA-256 da senha enviado para Qwen API (playwright.ts:239) é protocolo do Qwen, não nosso — não podemos mudar isso. A criptografia é apenas para armazenamento em repouso.
  </action>
  <verify>Sem QWEN_ENCRYPTION_KEY → senhas em plaintext com warning. Com key → database contém dados criptografados (não legíveis sem a key).</verify>
  <done>Senhas criptografadas com AES-256-GCM; migration automática; fallback seguro sem key</done>
</task>

<task type="auto">
  <name>Task 10: TLS opcional nativo</name>
  <files>src/core/config.ts, src/api/server.ts</files>
  <action>
    Adicionar suporte opcional a TLS nativo no servidor HTTP:
    
    1. **Config**: `SSL_ENABLED=false`, `SSL_CERT_PATH=./cert.pem`, `SSL_KEY_PATH=./key.pem`
    2. **Server**: se `SSL_ENABLED=true`, usar `https.createServer({ cert, key })` em vez de `serve()` do Hono
    3. **Documentar**: no .env.example e README, instruções para gerar self-signed cert ou usar Let's Encrypt
    4. **Nota**: TLS nativo é útil para deployments sem reverse proxy. Para produção com nginx/Cloudflare, TLS no proxy reverso é suficiente.
  </action>
  <verify>SSL_ENABLED=true + cert files → servidor HTTPS + HSTS header presente. SSL_ENABLED=false → HTTP + sem HSTS.</verify>
  <done>TLS nativo opcional implementado; HSTS condicional revisado; deployments HTTP puros sem header incorreto</done>
</task>

<task type="auto">
  <name>Task 11: Resolver dependências chat.ts entre fases</name>
  <files>.planning/ROADMAP.md, .planning/phases/01-qwenproxy-hardening.md, .planning/phases/02-tool-calling-hardening.md, .planning/phases/03-code-quality-cleanup.md</files>
  <action>
    Todas as 3 fases modificam `chat.ts`. As dependências documentadas dizem:
    - Fase 01 + 02 conflitam em chat.ts
    - Fase 03 NÃO tem conflito com Fase 02 (arquivos diferentes)
    - Fase 03 conflita com Fase 01 (qwen.ts)
    
    Mas a análise revelou que Fase 03 Task 5 (reduzir any) também modifica chat.ts, CONFLITANDO com Fase 02 (tool_choice). 
    
    Correção:
    1. Documentar que Fase 03 DEVE vir DEPOIS da Fase 02 (não apenas depois da Fase 01)
    2. Atualizar ROADMAP.md: Fase 03 depende de Fase 02 → Fase 03
    3. Em Phase 03, adicionar warning: "⚠️ DEPENDÊNCIA: Esta fase modifica chat.ts (Task 5 — reduzir any). Deve ser executada APÓS a Fase 02 para evitar conflitos de merge."
    4. Em Phase 02, mencionar que chat.ts modificado pode ter linhas deslocadas
    5. Adicionar verificação de `git diff --name-only` entre fases para detectar conflitos
  </action>
  <verify>ROADMAP.md atualizado com cadeia de dependência correta: 01→02→03→04. Phase 03 tem warning sobre chat.ts.</verify>
  <done>Dependências chat.ts documentadas corretamente; cadeia: 01→02→03→04</done>
</task>

</tasks>

<done_when>
- [ ] `npx tsc --noEmit` passa sem erros
- [ ] `npm test` passa com todos os testes
- [ ] CAPTCHA detection multi-camada funcional (iframe + script + URL + window)
- [ ] Prometheus metrics em formato válido (promtool check metrics)
- [ ] npm audit integrado (npm run audit executa sem erro)
- [ ] Request ID tracking: x-request-id propagado em requests e logs
- [ ] Per-tool-call timeout + size limits ativos
- [ ] Timeout hierarchy documentada (EXECUTOR_TIMEOUT_MS > per-tool TOOL_TIMEOUT_MS)
- [ ] Login human-like com delays randomizados
- [ ] /metrics protegido por API Key
- [ ] Senhas criptografadas com AES-256-GCM (ou fallback plaintext com warning)
- [ ] QWEN_ENCRYPTION_KEY obrigatoria em NODE_ENV=production (fail fast se ausente)
- [ ] TLS opcional funcional
- [ ] Dependências chat.ts documentadas: 01→02→03
- [ ] Regressão zero: testes antigos intactos
</done_when>

<stop_if>
- [ ] Typecheck falhar
- [ ] Testes existentes quebrarem
- [ ] CAPTCHA detection falso positivo em página normal (detectar CAPTCHA onde não existe)
- [ ] Prometheus metrics quebrarem scraping existente
- [ ] Login flow quebrar completamente (não apenas ficar mais lento)
- [ ] TLS failure impedir servidor de subir mesmo com SSL_ENABLED=false
- [ ] Criptografia de senhas corromper dados existentes
- [ ] Metrics auth quebrar monitors que dependem de /metrics aberto
- [ ] CAPTCHA detection falso negativo — CAPTCHA real presente mas nenhuma camada detecta
- [ ] SSL_ENABLED=true com certificado invalido — servidor nao sobe
</stop_if>

<checkpoints>
- [ ] Checkpoint 1 (Tasks 1-2): CAPTCHA + Prometheus — testes passam
- [ ] Checkpoint 2 (Tasks 3-4): npm audit + Request ID — CI green
- [ ] Checkpoint 3 (Task 6): Per-tool-call timeout — typecheck + testes
- [ ] Checkpoint 4 (Tasks 7-8): Login human-like + metrics auth — servidor funcional
- [ ] Checkpoint 5 (Tasks 9-10): Criptografia + TLS — deployável
- [ ] Checkpoint 6 (Task 11): Dependências documentadas — ROADMAP atualizado
- [ ] Checkpoint 7: Revisão final integrada — todos os testes + typecheck + servidor
</checkpoints>

<validation>
- minimum: `npx tsc --noEmit` + `npm test` + servidor sobe
- gate: Teste manual completo:
  1. curl /metrics sem API Key → 401
  2. curl /metrics com API Key → texto Prometheus válido
  3. curl /health → playwright.captcha_detected incluso
  4. npm run audit → executa sem erro fatal
  5. Login flow com delays (observável)
  6. Senhas criptografadas no SQLite (db file não legível)
  7. TLS opcional funcional
</validation>

<rollback>
- trigger: Qualquer STOP_IF acionado
- action: `git diff --name-only > /tmp/qwenproxy-rollback-04-paths.txt && for f in $(cat /tmp/qwenproxy-rollback-04-paths.txt); do git checkout HEAD -- "$f" 2>/dev/null; done` para reverter APENAS arquivos modificados nesta fase. **NÃO usar `git checkout -- .` ou `git clean -fd`** — isso destruiria mudanças de fases anteriores. Verificar que fases anteriores continuam intactas com `npm test`.
Remover novos arquivos nao rastreados desta fase manualmente com rm -f .github/workflows/security.yml
</rollback>

<owners>
- owner: Claude Code (franc)
- next: `plan-loop --mode autonomous_fix --max-iterations 3 --profile auto`
</owners>

<success_criteria>
- Explicit GOAL
- Explicit CLAIM
- Measurable FASTEST_DISPROOF_TEST
- Clear scope in/out
- Objective DONE_WHEN
- Objective STOP_IF
- Verifiable checkpoints
- Defined validation ladder
- Explicit rollback and handoff
</success_criteria>
</phase>
