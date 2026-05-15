# Changelog

## 1.0.1 - 2026-05-15

### Corrigido
- trocado o reparo caseiro principal por `jsonrepair` para lidar melhor com JSON de tool call quebrado ou quase válido
- evitada a perda silenciosa de `<tool_call>` inválido durante o streaming
- corrigido o retry semântico para não disparar quando já existe tool call válido no mesmo lote

### Melhorado
- adicionado retry semântico de 1 tentativa pedindo reenvio de tool call válido quando o primeiro payload vem inválido
- parser agora diferencia tool calls válidos, inválidos e texto de fallback
- ampliada a cobertura de testes para parsing robusto, fallback seguro, limite do retry, reasoning + retry e cenários mistos com tool calls válidos e inválidos
