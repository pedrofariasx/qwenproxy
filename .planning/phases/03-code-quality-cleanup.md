---
phase: 03-code-quality-cleanup
plan: 03
revision: 1
type: execute
---

<goal>
GOAL: Limpar débitos técnicos do QwenProxy que não bloqueiam funcionalidade mas acumulam risco de bugs futuros — token estimation precisa, tipos unificados, estado global eliminado, dependências não utilizadas removidas, e código mais defensivo no geral.
</goal>

> **⚠️ DEPENDÊNCIA:** Esta fase DEVE ser executada APÓS a Fase 02 (tool-calling-hardening). A Task 5 modifica `chat.ts` (reduzir any) — mesmo arquivo que a Fase 02 modifica extensivamente. Se executada antes, haverá conflitos de merge. Além disso, a Task 2 modifica `qwen.ts` (session state) que também é afetada pela Fase 01 (logger migration). **Ordem correta: Fase 01 → Fase 02 → Fase 03.**

<objective>
A análise revelou vários problemas de qualidade de código que não são críticos isoladamente mas somados criam risco de regressão:
(1) Token estimation usa `text.length / 3.5` — impreciso para Qwen,
(2) Variável global `_sessionStates` no `globalThis` — estado não encapsulado,
(3) Tipos duplicados entre `src/tools/types.ts`, `src/types/openai.ts`, `src/utils/types.ts` — risco de divergência,
(4) Dependências não utilizadas no package.json (`p-queue`, `piscina`),
(5) JSON schema type definitions sub-utilizadas,
(6) Falta de tipo estrito em várias funções de handler,
(7) Código com any implícito em vários pontos.

Output:
- Token estimation usando tiktoken ou fórmula calibrada para Qwen
- Estado de sessão encapsulado em classe/objeto module-scoped
- Tipos unificados em src/types/openai.ts como fonte única
- Dependências não utilizadas removidas do package.json
- strict mode do TypeScript respeitado (reduzir any explícito onde possível)
- Testes de token estimation adicionados
</objective>

<context>
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/utils/context-truncation.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/utils/json.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/utils/types.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/types/openai.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/tools/types.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/services/qwen.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/services/playwright.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/routes/chat.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/package.json
</context>

<claim>
CLAIM: Após aplicar este plano, o QwenProxy terá token estimation mais precisa (usando tiktoken para Qwen), estado de sessão encapsulado sem globalThis, tipos unificados sem duplicação, dependências mortas removidas, e testes de token estimation.
</claim>

<fastest_disproof_test>
FASTEST_DISPROOF_TEST: Rodar `npm test` + `npx tsc --noEmit`. `grep -c 'globalThis' src/services/qwen.ts` retorna 0 (apenas o service module; test files podem usar globalThis.fetch para mock). `grep -r "from 'p-queue'\|from 'piscina'" src/` retorna vazio. `package.json` não contém p-queue nem piscina.
</fastest_disproof_test>

<scope>
- in:
  - Melhorar token estimation: substituir `text.length / 3.5` por contagem mais precisa
  - Encapsular `_sessionStates` — remover `globalThis`, usar ModuleScopedState pattern com export/import
  - Unificar tipos: src/types/openai.ts como fonte única; src/tools/types.ts e src/utils/types.ts re-exportam de lá
  - Remover dependências mortas: p-queue, piscina do package.json
  - npm audit fix (se compatível)
  - Reduzir `any` explícito onde substituível por tipos concretos
  - Adicionar teste unitário para estimateTokenCount

- out:
  - Não vai refatorar o sistema de tipos do Hono
  - Não vai adicionar barrel exports ou index.ts
  - Não vai fazer refactoring de nomes (apenas mover/eliminar)
  - Não vai adicionar testes de integração
  - Não vai mudar runtime (continua tsx, sem build step)
  - Não vai adicionar linters ou formatters
  - commit gate: apos cada fase, criar commit antes de avancar
</scope>

<constraints>
- Zero mudança na API de runtime
- Mudanças de tipo devem ser type-safe (não usar `as any` como "atalho")
- sessionStates deve manter a mesma funcionalidade: session -> parentId mapping
- Token estimation nova deve ser mais precisa que a atual (tolerância: +/- 20% do real)
- Dependências removidas não podem quebrar imports em lugar nenhum
- O código deve continuar rodando com tsx (sem build step)
</constraints>

<non_goals>
- Não vamos migrar para tiktoken oficial da OpenAI (dependência C pesada)
- Não vamos adicionar testes de benchmark de token estimation
- Não vamos refatorar o sistema de logging
- Não vamos adicionar strict mode total no tsconfig (seria breaking change)
- Não vamos adicionar barrel exports
</non_goals>

<tasks>

<task type="auto">
  <name>Task 1: Melhorar token estimation</name>
  <files>src/utils/context-truncation.ts, src/core/model-registry.ts</files>
  <action>
    Substituir `text.length / 3.5` por estimativa mais precisa.
    
    Abordagem 1 (preferida): Usar o pacote `gpt-tokenizer` (fast, sem native bindings) 
    com o encoding `cl100k_base` que é o mais próximo do Qwen (Qwen usa tokenização similar ao GPT-4).
    
    Abordagem 2 (fallback sem dependência externa): Usar `new TextEncoder().encode(text).length * 0.40` — 
    baseado em bytes UTF-8, que é mais preciso que character count para texto misto.
    
    Implementar como função separada que pode ser testada:
    ```typescript
    export function estimateTokenCount(text: string): number {
      // Usar cl100k_base se tiktoken disponível, fallback para bytes * 0.4
      const bytes = new TextEncoder().encode(text).length;
      return Math.ceil(bytes * 0.40);
    }
    ```
    
    Adicionar testabilidade: exportar a função pura, sem depender de config global.
    
    **NOTA:** Qwen não divulga oficialmente o tokenizer. A estimativa será sempre aproximada.
    O valor é usado apenas para context window truncation preventiva.
    Manter margem de segurança de 20% (já existe no código: `modelContextWindow - 1000`).
    **Não é possível verificar acurácia sem acesso à API Qwen.** O objetivo é ser "melhor que text.length / 3.5" para texto misto multilíngue (português + inglês + code), não uma contagem exata. Documentar como best-effort.
    
    Adicionar teste unitário em `src/tests/context-truncation.test.ts`:
    - String de 1000 chars → retorna número positivo
    - String vazia → retorna 0
    - Texto em português vs inglês (Qwen lida com multilíngue)
    
    Métrica alvo: documentar como best-effort (Qwen não publica tokenizer), erro <15% em texto médio. Considerar tiktoken como fallback opcional.
  </action>
  <verify>estimateTokenCount("Hello world") retorna número > 0. estimateTokenCount("") retorna 0 ou próximo.</verify>
  <done>Token estimation substituída por método mais preciso; teste unitário adicionado</done>
</task>

<task type="auto">
  <name>Task 2: Encapsular sessionStates sem globalThis</name>
  <files>src/services/qwen.ts</files>
  <action>
    Substituir o padrão atual:
    ```typescript
    const sessionStates: Record<string, string | null> = (globalThis as any)._sessionStates || {};
    (globalThis as any)._sessionStates = sessionStates;
    ```
    
    Por encapsulamento module-scoped puro:
    ```typescript
    const sessionStates = new Map<string, string | null>();
    
    export function updateSessionParent(sessionId: string, parentId: string | null) {
      if (sessionId) {
        sessionStates.set(sessionId, parentId);
      }
    }
    
    export function getSessionParent(sessionId: string): string | null | undefined {
      return sessionStates.get(sessionId);
    }
    
    export function clearSessionState(sessionId: string): void {
      sessionStates.delete(sessionId);
    }
    
    export function clearAllSessionStates(): void {
      sessionStates.clear();
    }
    ```
    
    Atualizar `createQwenStream` para usar `getSessionParent` em vez de `sessionStates[chatSessionId]`.
    
    Adicionar controle de memory leak: se o Map crescer >1000 entries, limpar entradas antigas (LRU aproximado usando timestamps).
    
    **⚠️ Hot-reload:** O Map é module-scoped. Se o módulo for hot-reloaded (ex: tsx watch), o estado é perdido — conversas multi-turn em andamento serão interrompidas. Isso é ACEITÁVEL (igual ao comportamento com globalThis, e melhor que vazar para escopo global). Hot-reload em produção não é suportado. Para desenvolvimento, esperar a sessão terminar antes de recarregar.
  </action>
  <verify>grep -c 'globalThis' src/services/qwen.ts → 0. createQwenStream continua funcionando com session tracking.</verify>
  <done>sessionStates encapsulado como Map module-scoped; globalThis eliminado; proteção contra memory leak</done>
</task>

<task type="auto">
  <name>Task 3a: Reconciliar ToolHandler/ToolContext (PRE-REQUISITO para unificacao)</name>
  <files>src/tools/types.ts, src/types/openai.ts</files>
  <action>
    ANTES de unificar tipos, reconciliar as assinaturas conflitantes de ToolHandler e ToolContext entre os 3 arquivos.

    Problema:
    - tools/types.ts define ToolHandler com genericos <TArgs = any, TResult = any>
    - openai.ts define ToolHandler sem genericos (Record<string, unknown> -> Promise<unknown>)
    - ToolsContext tem [key: string]: any; ToolExecutionContext NAO tem

    Solucao:
    1. Adotar a versao GENERICA em openai.ts: ToolHandler<TArgs = Record<string, unknown>, TResult = unknown>
    2. ToolContext em tools/types.ts DEVE incluir [key: string]: any
    3. Atualizar openai.ts ToolExecutionContext para ter state + [key: string]: any
    4. Atualizar TODOS os call sites (registry.ts, executor.ts, chat.ts) para usar a assinatura reconciliada

    **IMPORTANTE:** Esta task DEVE ser executada ANTES da Task 3b (unificacao). Executar na ordem inversa quebra o typecheck.
  </action>
  <verify>npx tsc --noEmit passa. ToolHandler aceita genericos em openai.ts. Ambos context types tem [key: string]: any.</verify>
  <done>ToolHandler/ToolContext reconciliados; signatures compativeis; typecheck passa</done>
</task>

<task type="auto">
  <name>Task 3b: Unificar tipos duplicados</name>
  <files>src/tools/types.ts, src/types/openai.ts, src/utils/types.ts</files>
  <action>
    Existem 3 fontes de tipos duplicadas: tools/types.ts, types/openai.ts, utils/types.ts. A task deve unificar TUDO em types/openai.ts.
    
    Situação atual:
    - `src/tools/types.ts` — define JsonSchema, FunctionToolDefinition, ToolRegistration, ToolHandler, ToolContext, ParsedToolCall, ToolCallResult
    - `src/types/openai.ts` — define JsonSchema, FunctionToolDefinition, ToolChoice, Message, MessageToolCall, OpenAIRequest, ChoiceDelta, Choice, Usage, ChatCompletionChunk, ParsedToolCall, ToolCallResult, ToolHandler, ToolRegistration, ToolPolicy
    - `src/utils/types.ts` — re-exporta de tools/types.ts, define ToolChoice, MessageToolCall, Message, OpenAIRequest, ToolCall, ChoiceDelta, Choice, Usage, ChatCompletionChunk
    
    Estratégia de unificação:
    1. `src/types/openai.ts` → fonte única de verdade. Manter aqui TODAS as definições.
    2. `src/tools/types.ts` → re-exportar de openai.ts, adicionar APENAS ToolHandler, ToolContext, ToolRegistration, ParsedToolCall, ToolCallResult (que são específicas do sistema de tools interno)
    3. `src/utils/types.ts` → RE-EXPORTAR de openai.ts SEM definições próprias (apenas re-export + alias)
    
    **Verificar imports em todos os arquivos source:**
    - `chat.ts` importa de `utils/types.ts` → OK, continua funcionando
    - `tools/registry.ts` importa de `tools/types.ts` → OK
    - Nenhum import precisa ser mudado, apenas a fonte das definições
    
    ⚠️ Garantir que as interfaces são IDÊNTICAS — qualquer diferença (ex: ToolHandler tem args vs exec context) será resolvida usando a versão de openai.ts e ajustando tools/types.ts para re-exportar.
  </action>
  <verify>npx tsc --noEmit passa sem erros. Interfaces em tools/types.ts são re-exports, não definições próprias (exceto ToolHandler, ToolContext, ToolRegistration).</verify>
  <done>Tipos unificados em openai.ts como fonte única; tools/types.ts re-exporta com acréscimos; typecheck passa</done>
</task>

<task type="auto">
  <name>Task 4: Remover dependências não utilizadas</name>
  <files>package.json</files>
  <action>
    Identificar dependências que NÃO são importadas em nenhum arquivo .ts:
    - `p-queue` — instalado mas não usado (verificar com grep)
    - `piscina` — instalado mas não usado (verificar com grep)
    
    Procedimento:
    1. `grep -r "from 'p-queue'" src/` — se não achar, remover
    2. `grep -r "from 'piscina'" src/` — se não achar, remover
    3. Verificar se alguma dependência usa p-queue/piscina indiretamente (peer dependency)
    4. Remover do package.json
    5. Rodar `npm install` para atualizar package-lock.json
    6. Rodar testes para confirmar que nada quebrou
    
    Se p-queue for usado em algum lugar não óbvio (ex: import dinâmico), documentar.
  </action>
  <verify>grep -r "p-queue\|piscina" src/ → vazio. npm test → passa. npm ls p-queue → not installed.</verify>
  <done>p-queue e piscina removidos do package.json; package-lock atualizado; testes passam</done>
</task>

<task type="auto">
  <name>Task 5: Reduzir any explícito onde possível</name>
  <files>src/routes/chat.ts</files>
  <action>
    Revisar chat.ts e substituir `any` por tipos concretos onde for seguro.
    
    Alvos principais:
    - `body: OpenAIRequest` já é tipado, mas `bodyAny` usa `as any` — eliminar bodyAny e usar body tipado
    - `msg.tool_calls` — tipar como `MessageToolCall[]` em vez de `any[]`
    - `chunk.choices[0].delta.extra.summary_thought.content` — tipar corretamente
    - Variáveis de erro: `err: any` → `err: unknown` com narrowing
    
    **Regra:** Não gastar tempo em refactoring cosmético. Focar em:
    - Onde `any` esconde bugs potenciais (ex: err sem tipo → pode acessar .upstreamCode sem verificar)
    - Onde `any` impede type-checking de parâmetros importantes
  </action>
  <verify>npx tsc --noEmit passa. Nenhum as any novo introduzido. Código funcionalmente idêntico.</verify>
  <done>any reduzido onde arriscado; código continua funcionalmente idêntico; typecheck passa</done>
</task>

<task type="auto">
  <name>Task 6: Adicionar teste de token estimation</name>
  <files>src/tests/context-truncation.test.ts (novo)</files>
  <action>
    Criar teste unitário para `estimateTokenCount` e `truncateMessages`:
    
    1. estimateTokenCount:
       - String vazia → 0 (ou 1, depende da implementação)
       - String pequena ("hello") → número pequeno (> 0)
       - String de 1000 caracteres → número razoável (200-400 tokens)
       - Texto multilíngue (português + inglês) → funciona sem erro
       - Texto com emojis/caracteres especiais → funciona sem erro
    
    2. truncateMessages:
       - Mensagens que cabem na context window → retorna todas
       - Mensagens que excedem → trunca preservando sistema + message mais recente
       - Sempre inclui system prompt
       - Safety margin respeitada
    
    3. Regressão: verificar que o valor de truncation não é tão agressivo a ponto de perder o prompt do usuário
  </action>
  <verify>npm test inclui context-truncation.test.ts e passa</verify>
  <done>Teste de token estimation adicionado e passando</done>
</task>

<task type="auto">
  <name>Task 7: Remover declaração duplicada de completionId em chat.ts</name>
  <files>src/routes/chat.ts</files>
  <action>Em chat.ts, existem duas declarações 'const completionId = ...': uma dentro do loop de accounts (linha ~241) e outra fora (linha ~324). A primeira é a correta (usada antes do streaming iniciar). Remover a segunda declaração (linha ~324). Manter APENAS a primeira (linha ~241).</action>
  <verify>npx tsc --noEmit passa; chat.ts tem exatamente 1 declaração de completionId</verify>
  <done>Declaração duplicada removida; completionId único em chat.ts</done>
</task>

<task type="auto">
  <name>Task 8: Structured JSON logging (LOG_FORMAT)</name>
  <files>src/core/logger.ts, src/core/config.ts</files>
  <action>
    O Logger atual sempre outputa texto colorido para terminal. Adicionar formato JSON estruturado:

    1. **Config**: LOG_FORMAT=text (default, compativel) ou LOG_FORMAT=json
    2. **JSON format**: {"timestamp":"...","level":"INFO","module":"Server","message":"..."}
    3. **Request ID**: se logger tem requestId ativo, incluir no JSON
    4. **Error objects**: quando logar erro, incluir stack trace como campo separado

    Implementar como formatter plugavel no Logger (Strategy pattern).
    Adicionar logger.withRequestId(id) que retorna nova instancia com requestId incluso.
  </action>
  <verify>LOG_FORMAT=json → logs em JSON parseavel. LOG_FORMAT=text → mesmo formato colorido.</verify>
  <done>Structured JSON logging implementado; LOG_FORMAT configuravel; backward compatible</done>
</task>

<task type="auto">
  <name>Task 9: Stream registry race protection + TTL cleanup</name>
  <files>src/core/stream-registry.ts</files>
  <action>
    Tres correcoes no stream-registry.ts:

    1. **Race condition**: getStream() + ler headers + removeStream() nao e atomico. Adicionar Mutex simples.
    2. **Memory leak**: o Map interno nunca e limpo se removeStream nao for chamado. Adicionar:
       - TTL de 5 minutos por entrada, usando lastAccessed timestamp atualizado a cada leitura (nao createdAt). Streams ativas renovam TTL a cada acesso.
       - Cleanup periodico a cada 60s que varre entradas expiradas
    3. **Thread safety**: duas requisicoes para o mesmo completionId — a segunda sobrescreve a primeira.

    Usar setInterval com .unref() para nao impedir o processo de fechar.
  </action>
  <verify>Dois acessos concorrentes ao mesmo stream nao corrompem estado. Stream expirado (>5min) removido.</verify>
  <done>Stream registry com protecao de concorrencia + TTL + cleanup periodico; sem memory leak</done>
</task>

<task type="auto">
  <name>Task 10: accountMutexes cleanup + account deactivation</name>
  <files>src/routes/chat.ts</files>
  <action>
    O Map accountMutexes (chat.ts:27-35) acumula entries para sempre, mesmo se conta removida.

    Correcao:
    1. Adicionar funcao removeAccountMutex(accountId) que deleta a entry do Map
    2. Exportar e chamar de closePlaywrightForAccount (em playwright.ts)
    3. Se accountMutexes crescer >100 entries, fazer cleanup de entries orfas

    Tambem limpar accountHeaderCaches, accountPages, accountContexts quando conta desativada.
  </action>
  <verify>Apos remover conta, accountMutexes nao tem entry para ela. Map nunca excede contas ativas.</verify>
  <done>accountMutexes cleanup implementado; Map nao acumula entries orfas</done>
</task>

<task type="auto">
  <name>Task 11: Heartbeat protection + watchdog race fix</name>
  <files>src/routes/chat.ts, src/core/watchdog.ts</files>
  <action>
    Duas correcoes:

    1. **Heartbeat** (chat.ts:496-501): callback async dentro de setInterval pode rejeitar silenciosamente.
       Usar .catch() sincrono: streamWriter.write(...).catch(() => {})

    2. **Watchdog race** (watchdog.ts): recoveryInProgress protege triggerRecovery() mas NAO performHealthCheck().
       Adicionar no inicio de performHealthCheck():
       if (this.recoveryInProgress) return;
  </action>
  <verify>Heartbeat com erro de escrita nao causa unhandled rejection. Watchdog nao inicia health check durante recovery.</verify>
  <done>Heartbeat protegido contra unhandled rejection; watchdog race condition corrigida</done>
</task>

<task type="auto">
  <name>Task 12: Chamar syncModelContextWindows apos fetch</name>
  <files>src/services/qwen.ts</files>
  <action>
    Em qwen.ts, fetchQwenModels() popula cachedModels mas NUNCA chama syncModelContextWindows() do model-registry.

    Correcao:
    - Apos fetchQwenModels() atualizar cachedModels, chamar syncModelContextWindows(json.data)
    - Importar syncModelContextWindows de src/core/model-registry
    - Fazer apenas quando models sao atualizados (nao no cache hit)
    - Envolver chamada em try/catch para evitar crash no fetch cycle se model-registry nao estiver inicializado

    Teste: verificar que model-registry tem context windows atualizados apos fetch.
  </action>
  <verify>Apos fetchQwenModels(), model-registry reflete context windows da API Qwen.</verify>
  <done>syncModelContextWindows chamado apos fetch; context windows sincronizados com Qwen API</done>
</task>

<task type="auto">
  <name>Task 13: Centralizar env vars de teste (TEST_MOCK_PLAYWRIGHT)</name>
  <files>src/services/playwright.ts</files>
  <action>
    Atualmente, process.env.TEST_MOCK_PLAYWRIGHT e process.env.TEST_SESSION_ID sao lidos direto em varias funcoes.

    Centralizar em uma interface:
    let testOptions = {
      mockMode: process.env.TEST_MOCK_PLAYWRIGHT === 'true',
      mockSessionId: process.env.TEST_SESSION_ID,
    };
    export function setTestOptions(opts) { ... }

    Todas as funcoes usam testOptions.mockMode em vez de process.env.
  </action>
  <verify>Todos os testes existentes passam. TEST_MOCK_PLAYWRIGHT so aparece em UM lugar.</verify>
  <done>Env vars de teste centralizadas em PlaywrightTestOptions; testes intactos</done>
</task>
</tasks>

<done_when>
- [ ] `npm test` passa com teste de token estimation incluso
- [ ] `npx tsc --noEmit` passa sem erros
- [ ] `grep -c 'globalThis' src/services/qwen.ts` retorna 0 (test files podem usar globalThis.fetch para mock — não incluir na verificação)
- [ ] `src/tools/types.ts` re-exporta de `openai.ts` em vez de redefinir tipos base
- [ ] `grep -r "from 'p-queue'\|from 'piscina'" src/` → vazio
- [ ] `package.json` não contém p-queue nem piscina
- [ ] Token estimation mais precisa que `text.length / 3.5`
- [ ] Teste unitário de context truncation existe e passa
- [ ] LOG_FORMAT json/text funcional
- [ ] Stream registry com TTL + mutex (race condition corrigida)
- [ ] accountMutexes cleanup implementado (Map sem entries orfas)
- [ ] Heartbeat protegido (sem unhandled rejection)
- [ ] Watchdog race condition corrigida (recoveryInProgress + performHealthCheck)
- [ ] Model registry sync apos fetch (syncModelContextWindows chamado)
- [ ] process.env.TEST_MOCK_PLAYWRIGHT so aparece em UM lugar (src/services/playwright.ts). Funcoes usam testOptions.mockMode — aceitavel em multiplos arquivos.
- [ ] Apos cada fase: git add -A && git commit -m "phase-N: <summary>" para criar checkpoint seguro para rollback
</done_when>

<stop_if>
- [ ] Typecheck falhar após migração de tipos
- [ ] sessionState não funcionar mais para session tracking
- [ ] p-queue ser usado em import dinâmico e quebrar
- [ ] Testes de advanced.test.ts falharem (session tracking)
- [ ] Token estimation nova cortar mais mensagens que a antiga (regressão)
- [ ] Qualquer erro de runtime relacionado a tipo
- [ ] JSON logging quebrar formato existente (LOG_FORMAT=text)
- [ ] Stream registry TTL remover streams ativas (mais recentes que 5min)
</stop_if>

<checkpoints>
- [ ] Checkpoint 1 (Tasks 1-2): token estimation + sessionState — testes passam
- [ ] Checkpoint 2 (Tasks 3-4): tipos unificados + deps removidas — typecheck passa
- [ ] Checkpoint 3 (Tasks 5-6): any reduzido + teste truncation — tudo passando
- [ ] Checkpoint 4 (Task 7): completionId duplicado removido — typecheck passa
- [ ] Checkpoint 5 (Tasks 8-9): JSON logging + stream registry — testes passam
- [ ] Checkpoint 6 (Tasks 10-11): accountMutexes cleanup + heartbeat/watchdog
- [ ] Checkpoint 7 (Tasks 12-13): model-registry sync + test options — tests passam
</checkpoints>

<validation>
- minimum: `npx tsc --noEmit` + `npm test` + servidor sobe
- gate: Teste manual com:
  1. Conversa multi-turn com session tracking funcionando (advanced tests verificam)
  2. Token estimation não truncar excessivamente prompts normais
  3. Servidor rodando sem erros de import
</validation>

<rollback>
- trigger: Qualquer STOP_IF acionado
- action: `git diff --name-only > /tmp/qwenproxy-rollback-03-paths.txt && for f in $(cat /tmp/qwenproxy-rollback-03-paths.txt); do git checkout HEAD -- "$f" 2>/dev/null; done` para reverter APENAS arquivos modificados nesta fase. **NÃO usar `git checkout -- .` ou `git clean -fd`** — isso destruiria mudanças de fases anteriores. Verificar que fases anteriores continuam intactas com `npm test`.
- Remover novos arquivos nao rastreados desta fase manualmente com rm -f src/tests/context-truncation.test.ts
</rollback>

<owners>
- owner: Claude Code (franc)
- next: Fase 02 (tool calling) concluída → executar esta fase
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
