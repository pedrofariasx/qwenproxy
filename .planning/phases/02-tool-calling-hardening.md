---
phase: 02-tool-calling-hardening
plan: 02
revision: 1
type: execute
---

<goal>
GOAL: Transformar o sistema de tool calling do QwenProxy de "instrutivo no system prompt + parser reativo" para "compatível com OpenAI function calling spec — com suporte real a tool_choice, execução server-side opcional, parsing determinístico sem dupla tentativa, e índices corretos no streaming".
</goal>

> **⚠️ DEPENDÊNCIA:** Esta fase DEVE ser executada APÓS a Fase 01 (qwenproxy-hardening). Ambas modificam `chat.ts` (Fase 01: logger migration nas linhas 231,236,274,284,303,752,799,806,809; Fase 02: tool_choice nas linhas 169-190, índices nas linhas 637-655). Se executadas fora de ordem, haverá conflitos de merge. Verificar com `git status` antes de iniciar.

<objective>
O sistema atual de tool calling funciona mas tem fragilidades fundamentais:
(1) `tool_choice` é ignorado — tools são sempre injetadas no prompt independente do valor,
(2) `ExecutionLoop` existe mas nunca é conectado — tool calls sempre retornam ao cliente,
(3) `parseToolContent` faz dupla tentativa de parse gerando duplicatas potenciais,
(4) Cálculo de índice de tool calls no streaming é frágil e pode gerar índices negativos,
(5) Qwen pode ignorar as instruções de tool calling sem detecção pelo proxy.

Output:
- `tool_choice: 'none'` respeitado (tools não injetadas no prompt)
- `tool_choice: 'required'` e `tool_choice: {type:'function', function:{name:'...'}}` respeitados
- `parseToolContent` refatorado para parsing único (else if em vez de sempre tentar ambos)
- Índice de tool calls no streaming simplificado e livre de bugs
- ExecutionLoop conectado como modo opcional (configurável)
- Validação de schemas anyOf/oneOf implementada
- Testes unitários expandidos para tool choice + execução server-side
</objective>

<context>
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/routes/chat.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/tools/parser.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/tools/executor.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/tools/registry.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/tools/schema.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/tools/types.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/types/openai.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/utils/types.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/core/config.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/tests/parser.test.ts
@/mnt/c/Users/franc/OneDrive/Documentos/projetos/qwenproxy/src/tests/agenticStress.test.ts
</context>

<claim>
CLAIM: Após aplicar este plano, o QwenProxy respeitará `tool_choice` conforme a OpenAI spec, o parser será determinístico sem dupla tentativa de parse, os índices de tool calls no streaming serão corretos em qualquer cenário, o ExecutionLoop poderá ser opcionalmente ativado para execução server-side de tools, e o schema validator suportará anyOf/oneOf para tool definitions complexas.
</claim>

<fastest_disproof_test>
FASTEST_DISPROOF_TEST: Rodar `npm test` — todos os testes existentes passam (parser, delta, json, rotation, concurrency, index, advanced). Adicionar e passar 3 novos testes:
1. `tool_choice: 'none'` — tools não aparecem no system prompt final (inspecionar a string gerada)
2. `parseToolContent` com conteúdo com \n — não gera tool calls duplicadas
3. Streaming com tool calls em ordem diferente — índices positivos e corretos
</fastest_disproof_test>

<scope>
- in:
  - `tool_choice: 'none'` → não injetar tools no system prompt
  - `tool_choice: 'required'` → forçar execução de tool (adicionar no prompt para o modelo)
  - `tool_choice: {type:'function', function:{name:'...'}}` → forçar tool específica
  - Refatorar `parseToolContent` em parser.ts: linhas 400-429 — substituir dupla tentativa por `if/else if` lógico
  - Simplificar cálculo de índice de tool calls no streaming (chat.ts:637-655) — usar contador explícito em vez de fórmula com emittedToolCallCount
  - Conectar ExecutionLoop opcionalmente: nova flag `EXECUTOR_ENABLED=false` no config; quando true, after retornar tool calls, executar server-side
  - Adicionar suporte a anyOf/oneOf no schema validator (schema.ts)
  - Adicionar detecção de "Qwen ignorou tools": verificar se o prompt pede tool calling e resposta é apenas texto sem tags → marcar como possível falha
  - Expandir parser.test.ts com edge cases: tool calls com conteúdo multiline, índices, tool_choice
  - Adicionar integration test para execução server-side (usando TEST_MOCK_PLAYWRIGHT)
  - Documentar as mudanças no README.md

- out:
  - Não vai implementar streaming de tool calls parciais (tool_call deltas incrementais por argumentos)
  - Não vai adicionar suporte a parallel_tool_calls (OpenAI parâmetro)
  - Não vai refatorar o StreamingToolParser para outra estratégia (continua com <tool_call> tags)
  - Não vai adicionar cache de tool definitions
  - Não vai implementar tool calling nativo da API Qwen (se um dia existir)
  - Não vai adicionar suporte a plugins/third-party tools
</scope>

<constraints>
- Zero mudança no formato wire API do OpenAI para streaming (tool_call deltas continuam compatíveis)
- Não pode quebrar parser.test.ts — testes existentes devem passar
- Não pode introduzir latência adicional no caminho non-tool (streaming sem tools)
- ExecutionLoop quando desligado (default) não altera comportamento atual
- tool_choice: 'none' deve funcionar mesmo com tools definidas no request
- Manter suporte a múltiplos formatos de tool_call (JSON, Hermes XML, array JSON)
- Índices de tool calls no streaming devem ser monotônicos e começar em 0
</constraints>

<non_goals>
- Não vamos adicionar tool calling nativo da API Qwen
- Não vamos substituir o sistema de tags <tool_call> por function calling nativo
- Não vamos adicionar guardrails de segurança em tool execution
- Não vamos implementar tool calling concorrente (o paralelismo já existe em executor.ts)
- Não vamos adicionar streaming de arguments de tool calls
</non_goals>

<tasks>

<task type="auto">
  <name>Task 1: Respeitar tool_choice corretamente</name>
  <files>src/routes/chat.ts</files>
  <action>
    No handler `chatCompletions`, modificar a lógica de injeção de tools no system prompt (linhas 170-190):
    
    - Se `tool_choice === 'none'` → não adicionar tools no prompt, não adicionar instruções de formato
    - Se `tool_choice === 'required'` → adicionar tools + instrução "Você DEVE usar uma tool nesta resposta"
    - Se `tool_choice === 'auto'` ou `undefined` → comportamento atual (adicionar tools formatadas, sem forçar)
    - Se `tool_choice` é objeto com `{type:'function', function:{name:'X'}}` → forçar tool X especificamente
    - Se tools não é definido ou array vazio → não adicionar nada independente do tool_choice
    
    Lógica implementada como bloco único com switch/if-else claro.
    
    **Edge case:** `tool_choice: 'required'` sem tools definidas → retornar erro 400: "tool_choice='required' requires at least one tool to be defined." Ignorar silenciosamente mascara bug no cliente.
  </action>
  <verify>Teste com tool_choice: 'none' → system prompt NÃO contém "TOOLS AVAILABLE". Teste com tool_choice: 'required' → system prompt contém "DEVE usar uma tool".</verify>
  <done>tool_choice none/auto/required/forced são respeitados; tests passam</done>
</task>

<task type="auto">
  <name>Task 2: Refatorar parseToolContent para evitar dupla tentativa</name>
  <files>src/tools/parser.ts</files>
  <action>
    Em `StreamingToolParser.parseToolContent()` (linhas 400-429):
    
    Atualmente:
    1. Tenta `robustParseJSON` no string completo → se parseia, adiciona tool call
    2. **SEMPRE** tenta line-by-line se houver \n → pode adicionar DUPLICATAS
    
    Novo comportamento:
    1. Se `robustParseJSON` suceder e parsear UM objeto → usar esse, PULAR line-by-line
    2. Se `robustParseJSON` parsear um ARRAY → cada item é uma tool call, PULAR line-by-line  
    3. Se `robustParseJSON` falhar → tentar line-by-line (cada linha que é objeto JSON)
    4. Dedup: comparar por `name + sorted argument keys` (NÃO `JSON.stringify(arguments)` que é sensível à ordem das keys). Implementar função `isDuplicateToolCall(a, b)` que compara sorted keys.
    
    Implementar com `if/else if / else` claro e testável. Extrair lógica de dedup para função separada `isDuplicateToolCall(a: ParsedToolCall, b: ParsedToolCall): boolean`.
  </action>
  <verify>Teste com conteúdo multiline: `{"name":"x","arguments":{}}\n{"name":"y","arguments":{}}` → exatamente 2 tool calls, sem duplicatas</verify>
  <done>parseToolContent refatorado com fluxo determinístico; sem duplicatas; testes passam</done>
</task>

<task type="auto">
  <name>Task 3: Simplificar cálculo de índice de tool calls no streaming</name>
  <files>src/routes/chat.ts</files>
  <action>
    O cálculo atual em chat.ts nas linhas 637-655 e 695-713:
    ```typescript
    index: toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc)
    ```
    
    Essa fórmula assume que todas as tool calls retornadas por feed() são novas e que o contador emittedToolCallCount já foi incrementado. Isso é frágil se alguma ferramenta for malformada.
    
    Solução: em vez de usar a fórmula complexa, manter um **contador local** no chat.ts:
    ```typescript
    let toolCallIndex = 0;
    // quando for emitir:
    for (const tc of toolCalls) {
      const index = toolCallIndex++;
      // ... usa index em vez da fórmula
    }
    ```
    
    Isso é deterministicamente correto em qualquer cenário. Remover o uso de `getEmittedToolCallCount()` para cálculo de índice (manter para finish_reason).
    
    **Mesma correção no non-streaming** (linhas 466): `toolCallsOut.forEach((tc, idx) => tc.index = idx);` → substituir `idx` por contador sequencial.
  </action>
  <verify>Teste com 3 tool calls seguidas → índices 0,1,2. Teste com malformed seguida de válida → índices corretos independente.</verify>
  <done>Cálculo de índice simplificado e deterministicamente correto; removida dependência frágil de emittedToolCallCount</done>
</task>

<task type="auto">
  <name>Task 4: Conectar ExecutionLoop como modo opcional</name>
  <files>src/core/config.ts, src/routes/chat.ts, src/tools/executor.ts</files>
  <action>
    O `ExecutionLoop.runExecutionLoop()` em executor.ts está implementado mas NUNCA é chamado.
    
    **⚠️ CRÍTICO — Dual-execution hazard:** Quando `EXECUTOR_ENABLED=true`, tool_calls NÃO podem ser retornadas para o cliente (senão a tool executa DUAS VEZES: uma pelo proxy, uma pelo cliente). O proxy DEVE:
    - Substituir a resposta final pela saída do execution loop
    - NÃO incluir tool_calls na resposta (finish_reason = 'stop')
    
    **⚠️ CRÍTICO — Streaming + executor:** Em SSE streaming, o cliente se desconecta quando o stream fecha. NÃO é possível entregar resultados do executor loop após o SSE stream terminar. Portanto:
    - **Streaming + EXECUTOR_ENABLED=true:** NÃO usar. Se detectado, retornar erro 400: "EXECUTOR_ENABLED não é compatível com streaming. Use stream=false ou EXECUTOR_ENABLED=false."
    - **Non-streaming + EXECUTOR_ENABLED=true:** Suportado. O execution loop roda antes de retornar a resposta.
    
    **⚠️ CRÍTICO — Timeout:** `runExecutionLoop` aceita config com `maxTurns` mas NÃO tem timeout por turno. Adicionar AbortSignal com timeout global (EXECUTOR_TIMEOUT_MS=120000). Se exceder, abortar e retornar erro 504.
    
    **⚠️ CRÍTICO — Shutdown:** Se o servidor receber SIGINT/SIGTERM durante o execution loop, deve abortar o loop ativamente (não apenas esperar). Adicionar cleanup no shutdown handler.
    
    Config:
    - `EXECUTOR_ENABLED=false` (default)
    - `EXECUTOR_MAX_TURNS=10` (default)
    - `EXECUTOR_TIMEOUT_MS=120000` (timeout total do execution loop, incluindo todas as turns)
    
    Para implementar:
    1. Adicionar config no config.ts
    2. Em executor.ts: aceitar AbortSignal opcional, verificar a cada turn
    3. Em chat.ts: modo non-streaming apenas; rodar execution loop sincronamente; NÃO emitir tool_calls na resposta quando executor ativo
    4. Logging claro ("[Executor] Execução server-side de tools ativada")
    
    **⚠️ ⚠️ Regressão:** Se EXECUTOR_ENABLED=false (default), comportamento zero alterado.
  </action>
  <verify>
    EXECUTOR_ENABLED=false → comportamento exatamente igual ao atual.
    EXECUTOR_ENABLED=true + stream=true → retorna 400.
    EXECUTOR_ENABLED=true + stream=false + tools registradas → executa tools, resposta final sem tool_calls.
  </verify>
  <done>ExecutionLoop conectado atrás de flag; apenas non-streaming; com timeout e abort; sem dual-execution</done>
</task>

<task type="auto">
  <name>Task 5: Adicionar validação anyOf/oneOf no schema validator</name>
  <files>src/tools/schema.ts</files>
  <action>
    O schema validator atual (schema.ts linha 60-62) simplesmente ignora `anyOf`, `oneOf`, `allOf`, `not`, `if/then/else`:
    ```typescript
    default:
      return value;  // passa sem validar!
    ```
    
    Implementar:
    - `anyOf`: valor deve validar contra PELO MENOS um dos schemas. Tentar cada um, se qualquer passar → OK. Se todos falharem → erro com schemas tentados
    - `oneOf`: valor deve validar contra EXATAMENTE um dos schemas. Contar quantos passam, se !== 1 → erro
    - `allOf`: valor deve validar contra TODOS os schemas. Executar sequencial, acumular erros
    - `not`: valor NÃO deve validar contra o schema
    
    Adicionar path tracing para cada subschema (ex: `$.toolName.anyOf[0]`).
    
    ⚠️ NOTA: `if/then/else` é mais complexo e pode ficar para próxima iteração se o escopo crescer muito.
  </action>
  <verify>Schema com `anyOf: [{type: 'string'}, {type: 'number'}]` → string "abc" passa, number 123 passa, boolean false falha</verify>
  <done>anyOf e oneOf validados; allOf implementado; if/then/else documentado como future work</done>
</task>

<task type="auto">
  <name>Task 6: Adicionar detecção de modelo ignorando tools</name>
  <files>src/routes/chat.ts</files>
  <action>
    Quando tools são fornecidas e o modelo retorna uma resposta sem tool_calls (apenas texto), isso PODE ser um caso legítimo (tool_choice='auto' e modelo optou por não usar tools) OU o modelo pode ter ignorado as instruções.
    
    Adicionar detecção heurística:
    - Se tools estão definidas E tool_choice='auto' (ou undefined) E resposta não tem tool_calls → log INFO (comportamento normal — modelo optou por não usar tools, NÃO é warning)
    - Se tools estão definidas E tool_choice='required' E resposta não tem tool_calls → log ERROR + retornar erro 502 "Model failed to invoke tools despite tool_choice='required'"
    - Se tools estão definidas E content inclui termos como "I cannot use tools" / "I don't have access" / "I don't have the ability" → log WARN (modelo explicitamente recusou)
    
    Isso NÃO muda comportamento do cliente — apenas logging.
  </action>
  <verify>Log com INFO aparece quando tool_choice='auto' e modelo não chama tools (comportamento normal); log com ERROR aparece quando tool_choice='required' e modelo não chama tools</verify>
  <done>Detecção implementada com logging em 3 níveis (info, warn, error) conforme gravidade</done>
</task>

<task type="auto">
  <name>Task 7: Expandir testes de tool calling</name>
  <files>src/tests/parser.test.ts, src/tests/index.test.ts</files>
  <action>
    Adicionar novos testes no parser.test.ts:
    - tool_choice: 'none' não injeta tools
    - tool_choice: 'required' força tool calling
    - parseToolContent multiline sem duplicatas
    - tool calls com \n no meio do JSON arguments
    - tool calls com índice correto no streaming (simular)
    - schema validation com anyOf (string ou number)
    - schema validation com oneOf (apenas um schema válido)
    
    Adicionar em index.test.ts (que usa TEST_MOCK_PLAYWRIGHT):
    - Teste com tool_choice: 'none' → response não contém tool_calls
    - Teste com executorEnabled=false (default) → tool_calls são retornados ao cliente
    
    Verificar que os testes originais do parser (7/7 atuais) continuam passando.
  </action>
  <verify>npm test passa com novos testes + testes originais intactos</verify>
  <done>Todos os testes (antigos e novos) passam; cobertura de tool choice, índices, anyOf</done>
</task>

<task type="auto">
  <name>Task 8: Documentar mudanças</name>
  <files>README.md</files>
  <action>
    Atualizar README.md com:
    - Seção de Tool Calling explicando como funciona (system prompt injection + <tool_call> tags)
    - Tabela de suporte a tool_choice (none, auto, required, forced)
    - Flag EXECUTOR_ENABLED e como usar execução server-side
    - Exemplo de request com tools e tool_choice
    - Limitações conhecidas
  </action>
  <verify>README tem seção de Tool Calling com exemplos e tabela de compatibilidade</verify>
  <done>README atualizado com documentação completa de tool calling</done>
</task>

<task type="auto">
  <name>Task 9: Validar tool_choice.function.name contra prompt injection</name>
  <files>src/routes/chat.ts</files>
  <action>
    Em chat.ts linha ~188, o nome da tool forcada e interpolado diretamente no system prompt.
    Isso e vulneravel a PROMPT INJECTION.

    Correcao:
    1. Validar que tool_choice.function.name corresponde a UMA tool no array body.tools
    2. Se nao corresponder → retornar erro 400
    3. Se corresponder → usar o nome validado (da tool definition, nao do input)
    4. Comparacao case-sensitive
  </action>
  <verify>tool_choice com nome de tool invalido → 400. tool_choice com tool valida → funciona.</verify>
  <done>Prompt injection via tool_choice.name bloqueado; validacao contra registered tools</done>
</task>

<task type="auto">
  <name>Task 10: ExecutionLoop bridge + caller messages isolation</name>
  <files>src/tools/executor.ts, src/routes/chat.ts</files>
  <action>
    Duas correcoes no ExecutionLoop:

    1. **LLMSendFunction bridge**: Task 4 nao especificou o adapter. Criar funcao buildExecutorSendToLLM() que:
       - Chama createQwenStream() para cada turno
       - Le o stream completo via StreamingToolParser
       - Retorna {content, toolCalls, finishReason}
       - Gerencia account routing + mutex

    2. **Caller messages isolation**: executor.ts faz messages.push() no array ORIGINAL.
       - Criar copia const workingMessages = [...messages] no inicio
       - Usar workingMessages para todas as mutacoes
       - ExecutionLoop nao modifica o array do caller
  </action>
  <verify>EXECUTOR_ENABLED=true → execution loop chama createQwenStream. Array do caller nao e modificado.</verify>
  <done>LLMSendFunction bridge implementada; caller messages isoladas; sem side effects</done>
</task>

<task type="auto">
  <name>Task 11: Tool call metrics + stream registry cleanup</name>
  <files>src/routes/chat.ts, src/core/metrics.ts</files>
  <action>
    Duas melhorias operacionais:

    1. **Tool call metrics**: Adicionar counters no metrics.ts:
       - tools.parsed (labels: method=streaming|non-streaming)
       - tools.parse_errors
       - tools.executed (labels: tool_name)
       - tools.execution_duration (histogram)

    2. **Stream registry cleanup**: No finally do honoStream, chamar removeStream(completionId).
       Atualmente so e limpo por chatCompletionsStop — memory leak.
  </action>
  <verify>Request com tool calls → metrics tools.parsed > 0. Stream termina → entry removido do registry.</verify>
  <done>Tool call metrics implementadas; stream registry cleanup no finally; sem memory leak</done>
</task>

<task type="auto">
  <name>Task 12: Expandir testes para prompt injection e execution loop</name>
  <files>src/tests/parser.test.ts, src/tests/index.test.ts</files>
  <action>
    Adicionar testes:

    parser.test.ts:
    - Argumentos de tool que geram prompt injection → escapados corretamente

    index.test.ts (com TEST_MOCK_PLAYWRIGHT):
    - executorEnabled=true → resposta final NAO contem tool_calls
    - executorEnabled=true + stream=true → retorna 400
    - tool_choice.function.name invalido → 400

    Verificar que todos os testes anteriores continuam passando.
  </action>
  <verify>npm test passa com 4+ novos testes + todos os existentes intactos</verify>
  <done>Testes expandidos; prompt injection e execution loop cobertos; regressao zero</done>
</task>
</tasks>

<done_when>
- [ ] `npm test` passa com todos os testes (existentes + novos)
- [ ] `npx tsc --noEmit` passa sem erros
- [ ] tool_choice: 'none' não injeta tools no prompt
- [ ] tool_choice: 'required' força tool calling no prompt
- [ ] parseToolContent sem dupla tentativa — sem duplicatas em conteúdo multiline
- [ ] Índices de tool calls no streaming são 0,1,2... sempre
- [ ] ExecutionLoop conectado atrás de flag EXECUTOR_ENABLED=false (default)
- [ ] Schema validator valida anyOf/oneOf/allOf
- [ ] README documentado com tool calling
- [ ] Prompt injection via tool_choice.name bloqueado (validacao contra registered tools)
- [ ] ExecutionLoop bridge implementada (LLMSendFunction adapter)
- [ ] Caller messages nao modificadas pelo execution loop
- [ ] Tool call metrics ativas (parsed, errors, executed)
- [ ] Stream registry cleanup no finally do honoStream
- [ ] Regressão zero: testes antigos intactos
- [ ] Timeout hierarchy documentada: EXECUTOR_TIMEOUT_MS=120000 (total) > TOOL_TIMEOUT_MS=30000 (por tool call)
</done_when>

<stop_if>
- [ ] Qualquer teste existente quebrar
- [ ] Typecheck falhar
- [ ] tool_choice: 'none' ainda injetar tools no prompt
- [ ] parseToolContent ainda produzir duplicatas
- [ ] Streaming emitir tool_call com index negativo
- [ ] ExecutionLoop rodar com EXECUTOR_ENABLED=false
- [ ] Mudança incompatível no formato wire da API (verificar com test que compara response schema contra golden snapshot)
- [ ] tool_choice.function.name aceitar nomes invalidos (prompt injection)
</stop_if>

<checkpoints>
- [ ] Checkpoint 1 (Tasks 1-2): tool_choice + parseToolContent — testes passam
- [ ] Checkpoint 2 (Tasks 3-4): índice corrigido + ExecutionLoop conectado
- [ ] Checkpoint 3 (Tasks 5-6): schema anyOf + detecção de falha
- [ ] Checkpoint 4 (Tasks 7-8): testes expandidos + docs — tudo passando
- [ ] Checkpoint 5 (Tasks 9-10): prompt injection + bridge — testes passam
- [ ] Checkpoint 6 (Tasks 11-12): metrics + cleanup + testes expandidos — tudo passando
- [ ] Checkpoint 7: Revisão final — todos os testes, typecheck, servidor
</checkpoints>

<validation>
- minimum: `npx tsc --noEmit` + `npm test` + servidor sobe
- gate: Teste manual com:
  1. Request com tool_choice: 'none' → resposta sem tool calls
  2. Request com tools e tool_choice: 'required' → modelo tenta usar tools
  3. Schema com anyOf → valida corretamente
  4. EXECUTOR_ENABLED=true + ferramenta registrada → execução server-side
  5. Streaming com 3 tool calls → índices 0,1,2 monotônicos
</validation>

<rollback>
- trigger: Qualquer STOP_IF acionado
- action: `git diff --name-only > /tmp/qwenproxy-rollback-02-paths.txt && for f in $(cat /tmp/qwenproxy-rollback-02-paths.txt); do git checkout HEAD -- "$f" 2>/dev/null; done` para reverter APENAS arquivos modificados nesta fase. **NÃO usar `git checkout -- .` ou `git clean -fd`** — isso destruiria mudanças de fases anteriores. Verificar que fases anteriores continuam intactas com `npm test`.
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
