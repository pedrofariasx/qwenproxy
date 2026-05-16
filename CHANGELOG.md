# Changelog

## 1.0.3 - 2026-05-16

### Corrigido
- corrigido o retry de "The chat is in progress!" que estava sendo suprimido pelo `catch` do parser de erro JSON
- `RetryableQwenStreamError` agora é propagado corretamente para o handler de stream, permitindo retry automático com jitter de 2-4s

## 1.0.2 - 2026-05-16

### Adicionado
- `extractToolCallFromMalformed` em `src/utils/json.ts` para extrair tool calls de payloads parcialmente quebrados
- `isDebugEnabled` helper para logs condicionais baseado em `DEBUG_QWEN_PROXY`
- Limpeza defensiva no parser: remove tags XML/HTML residuais e entidades HTML antes de parsear JSON de tool calls

### Melhorado
- Refatorado `RetryableQwenStreamError` para `src/services/qwen.ts` (melhor organização de responsabilidades)
- Parser de tool calls agora lida com payloads quase-válidos com maior tolerância
- Executor de ferramentas com validação mais robusta de JSON antes de executar
- Logs de debug opcionais via variável de ambiente para troubleshooting de parsing

### Modificado
- `StructuredError` substitui `RetryableQwenStreamError` na rota de chat para respostas mais estruturadas
- Ajustes no parser de JSON para evitar perda silenciosa de tool calls com formatação marginal

## 1.0.1 - 2026-05-15

### Corrigido
- trocado o reparo caseiro principal por `jsonrepair` para lidar melhor com JSON de tool call quebrado ou quase válido
- evitada a perda silenciosa de `<tool_call>` inválido durante o streaming
- corrigido o retry semântico para não disparar quando já existe tool call válido no mesmo lote

### Melhorado
- adicionado retry semântico de 1 tentativa pedindo reenvio de tool call válido quando o primeiro payload vem inválido
- parser agora diferencia tool calls válidos, inválidos e texto de fallback
- ampliada a cobertura de testes para parsing robusto, fallback seguro, limite do retry, reasoning + retry e cenários mistos com tool calls válidos e inválidos
