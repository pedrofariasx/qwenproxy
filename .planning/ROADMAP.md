# ROADMAP — QwenProxy Hardening

## Fases

| # | Fase | Status | Prioridade | Depende de |
|---|------|--------|------------|-------------|
| 01 | qwenproxy-hardening | 🟢 Pronto para executar | 🔥 Crítica | — |
| 02 | tool-calling-hardening | 🟢 Plano completo | 🔥 Crítica | **Fase 01** (mesmo arquivo chat.ts) |
| 03 | code-quality-cleanup | 🟢 Plano completo | 🟡 Média | **Fase 01, Fase 02** (chat.ts + qwen.ts) |
| 04 | security-reliability-hardening | 🟢 Plano completo | 🔴 Alta | **Fase 02, Fase 03** |

> **⚠️ Ordem obrigatória:** Fase 01 → Fase 02 → Fase 03 → Fase 04.
> Fase 01 e 02 modificam `chat.ts` profundamente — aplicar fora de ordem causa conflitos de merge.
> Fase 03 modifica `chat.ts` (Task 5: reduzir any) e `qwen.ts` (session state) — deve vir APÓS a Fase 02.
> Fase 04 depende de todas as anteriores (assume código já estabilizado).
> Após cada fase, rodar `npm test` + `npx tsc --noEmit` para verificar integridade antes de avançar.
> IMPORTANTE: Apos cada fase, fazer `git add -A && git commit -m "phase-N: <summary>"` para estabelecer checkpoint seguro. Rollback usa checkout HEAD (ultimo commit) — sem commit, rollback de fases subsequentes pode destruir trabalho de fases anteriores.

## Detalhes

### Fase 01: QwenProxy Hardening

**Objetivo:** Corrigir bugs, adicionar resiliência e segurança, elevar qualidade para production-ready.

**Tarefas:**
1. Corrigir middleware de API Key (proteger /v1/models)
2. Adicionar `import crypto` em models.ts
3. Migrar console.log/error para Logger class
4. Validação Zod para chat completions request
5. Playwright header interception resiliente
6. Rate limiting configurável
7. Dockerfile otimizado (multi-stage)
8. Health endpoint enriquecido
9. .env.example documentado
10. Timing-safe API key + env var validation
11. Error sanitization (safe error messages)
12. Input size limits na validação Zod
13. Security headers middleware
14. Graceful shutdown timeout + MemoryCache eviction

**Critérios de sucesso:** 27/27 testes, typecheck limpo, servidor funcional, segurança defensiva (timing-safe, sanitization, input limits), cache com eviction.

---

### Fase 02: Tool Calling Hardening

**Arquivo:** `.planning/phases/02-tool-calling-hardening.md`

**Objetivo:** Transformar tool calling de "instrutivo no system prompt" para "compatível com OpenAI function calling spec — com suporte real a tool_choice, execução server-side opcional, parsing determinístico sem dupla tentativa, e índices corretos no streaming".

**Tarefas:**
1. Respeitar `tool_choice` corretamente (none, auto, required, forced)
2. Refatorar `parseToolContent` para evitar dupla tentativa de parse
3. Simplificar cálculo de índice de tool calls no streaming
4. Conectar `ExecutionLoop` como modo opcional (EXECUTOR_ENABLED)
5. Adicionar validação anyOf/oneOf no schema validator
6. Adicionar detecção de modelo ignorando tools
7. Expandir testes de tool calling
8. Documentar mudanças no README
9. Validar tool_choice.function.name contra prompt injection
10. ExecutionLoop bridge + caller messages isolation
11. Tool call metrics + stream registry cleanup
12. Expandir testes para prompt injection e execution loop

**Critérios de sucesso:** tool_choice respeitado, parse determinístico, índices corretos, executor opcional.

---

### Fase 03: Code Quality & Cleanup

**Arquivo:** `.planning/phases/03-code-quality-cleanup.md`

**Objetivo:** Limpar débitos técnicos — token estimation precisa, tipos unificados, estado global eliminado, dependências não utilizadas removidas.

**Tarefas:**
1. Melhorar token estimation (substituir `text.length / 3.5`)
2. Encapsular sessionStates sem `globalThis`
3. Reconciliar ToolHandler/ToolContext + unificar tipos duplicados
4. Remover dependências não utilizadas (p-queue, piscina)
5. Reduzir `any` explícito onde arriscado
6. Adicionar teste de context truncation
7. Remover declaração duplicada de completionId em chat.ts
8. Structured JSON logging (LOG_FORMAT)
9. Stream registry race protection + TTL cleanup
10. accountMutexes cleanup + account deactivation
11. Heartbeat protection + watchdog race fix
12. Chamar syncModelContextWindows após fetch
13. Centralizar env vars de teste (TEST_MOCK_PLAYWRIGHT)

**Critérios de sucesso:** Zero globalThis, tipos unificados, deps limpas, teste de token estimation, JSON logging, stream registry sem leak, watchdog sem race condition.

---

### Fase 04: Security & Reliability Hardening

**Arquivo:** `.planning/phases/04-security-reliability-hardening.md`

**Objetivo:** Elevar segurança defensiva — CAPTCHA multi-camada, Prometheus válido, npm audit, request ID, ToolHandler types, timeouts, login human-like, /metrics auth, criptografia SQLite, TLS opcional, dependências chat.ts resolvidas.

**Tarefas:**
1. CAPTCHA detection multi-camada (Turnstile)
2. Corrigir formato Prometheus histograma
3. npm audit + dependency scanning
4. Request ID tracking ponta-a-ponta
5. Per-tool-call timeout + size limits
6. Login flow human-like
7. Proteger /metrics endpoint
8. Criptografar senhas no SQLite
9. TLS opcional nativo
10. Resolver dependências chat.ts entre fases

**Critérios de sucesso:** CAPTCHA multi-camada, Prometheus válido, npm audit no CI, request ID tracking, ToolHandler reconciliado, per-tool timeout, login human-like, /metrics auth, senhas criptografadas, TLS opcional, dependências chat.ts documentadas.

---

## Próximas fases (candidatas futuras)
- **Fase 05:** Cache Redis + multi-instância
- **Fase 06:** Admin UI + monitoramento real-time
- **Fase 07:** Testes de integração com Qwen real (CI)
- **Fase 08:** Clustering/sh retain Playwright (múltiplos workers)
