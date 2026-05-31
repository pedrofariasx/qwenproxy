import { config } from './config.ts';
import { debugSearch } from './debug-search.ts';
import { maskSensitive, paint, terminal } from './terminal.ts';

type DebugMode = 'off' | 'basic' | 'full' | 'raw';
type DebugRoute = 'chat.completions' | 'responses';

type DebugStart = {
  id: string;
  route: DebugRoute;
  client?: string | null;
  model?: string;
  stream?: boolean;
  messages?: any[];
  input?: any;
  tools?: any[];
  previousResponseId?: string | null;
  sessionKey?: string | null;
};

type DebugComplete = {
  outputText?: string;
  reasoningText?: string;
  toolCalls?: any[];
  usage?: any;
  finishReason?: string;
  status?: string;
};

const VALID_MODES = new Set<DebugMode>(['off', 'basic', 'full', 'raw']);
const mode = VALID_MODES.has(config.debug.mode as DebugMode)
  ? config.debug.mode as DebugMode
  : 'off';

export function debugEnabled(): boolean {
  return mode !== 'off';
}

export function detectClientName(userAgent?: string | null, explicitClient?: string | null): string {
  if (explicitClient?.trim()) return explicitClient.trim();
  const ua = userAgent || '';
  const lower = ua.toLowerCase();
  if (lower.includes('opencode')) return 'OpenCode';
  if (lower.includes('zed')) return 'Zed';
  if (lower.includes('codex')) return 'Codex';
  if (lower.includes('kilo')) return 'Kilo';
  if (lower.includes('ai-sdk') || lower.includes('@ai-sdk')) return 'Vercel AI SDK';
  if (lower.includes('openai')) return 'OpenAI SDK';
  if (ua.trim()) return ua.slice(0, 80);
  return 'cliente desconhecido';
}

export function createDebugTrace(start: DebugStart): DebugTrace {
  return new DebugTrace(start);
}

class DebugTrace {
  readonly id: string;
  private readonly route: DebugRoute;
  private readonly startedAt = Date.now();
  private liveCharsPrinted = 0;
  private seenToolCalls = new Set<string>();
  private closed = false;

  constructor(private readonly start: DebugStart) {
    this.id = start.id;
    this.route = start.route;
    if (!debugEnabled()) return;
    const requestTag = debugSearch.tagForId(this.id, 'req');
    debugSearch.startRequest({
      id: this.id,
      route: start.route,
      client: start.client,
      model: start.model,
      stream: start.stream,
      inputPreview: start.messages || start.input,
    });

    this.section('request', [
      kv('tag', `#${requestTag}`),
      kv('rota', start.route),
      kv('cliente', start.client || 'cliente desconhecido'),
      kv('modelo', start.model || 'nao informado'),
      kv('stream', start.stream ? 'sim' : 'nao'),
      start.previousResponseId ? `Continua response: ${start.previousResponseId}` : null,
      start.sessionKey ? kv('sessao', start.sessionKey) : null,
      kv('entrada', summarizeInput(start)),
      kv('tools', summarizeTools(start.tools)),
    ], ['request', start.route, start.client || '', start.model || ''], [
      { id: this.id, kind: 'req' },
      ...(start.previousResponseId ? [{ id: start.previousResponseId, kind: 'resp' }] : []),
      ...(start.sessionKey ? [{ id: start.sessionKey, kind: 'session' }] : []),
    ]);

    if (mode === 'full' || mode === 'raw') {
      this.block('entrada recebida', compactJson({
        messages: start.messages,
        input: start.input,
        tools: start.tools,
      }), ['payload', 'request']);
    }
  }

  prompt(prompt: string, meta?: { estimatedTokens?: number; contextWindow?: number }) {
    if (!debugEnabled()) return;
    const lines = [
      kv('prompt final', `${prompt.length} caracteres`),
      meta?.estimatedTokens !== undefined ? kv('tokens estimados', String(meta.estimatedTokens)) : null,
      meta?.contextWindow !== undefined ? kv('janela do modelo', String(meta.contextWindow)) : null,
    ];
    debugSearch.updateRequest(this.id, {
      promptPreview: truncate(clean(prompt), config.debug.maxChars),
    });
    this.section('qwen request', lines, ['prompt', 'qwen']);

    if (config.debug.showPrompt || mode === 'raw') {
      this.block('prompt enviado', prompt, ['prompt', 'qwen']);
    } else if (mode === 'full') {
      this.block('prompt enviado (preview)', prompt, ['prompt', 'preview']);
    }
  }

  account(email: string, accountId: string) {
    if (!debugEnabled()) return;
    const accountTag = debugSearch.tagForId(accountId, 'acct');
    debugSearch.updateRequest(this.id, {
      account: email,
      accountTag,
    });
    this.section('conta', [
      kv('tag', `#${accountTag}`),
      kv('usando', email),
      kv('id', accountId),
    ], ['account'], [{ id: accountId, kind: 'acct' }]);
  }

  retry(message: string) {
    if (!debugEnabled()) return;
    debugSearch.appendRequestEvent(this.id, `retry: ${translateError(message).summary}`);
    this.section('retry', [translateError(message).summary, translateError(message).hint], ['retry', 'error']);
  }

  streamDelta(kind: 'answer' | 'reasoning', text: string) {
    if (!debugEnabled() || !text || mode === 'basic') return;
    if (this.liveCharsPrinted >= config.debug.maxChars && mode !== 'raw') return;

    const remaining = mode === 'raw'
      ? text.length
      : Math.max(0, config.debug.maxChars - this.liveCharsPrinted);
    const preview = truncate(clean(text), remaining);
    if (!preview) return;
    this.liveCharsPrinted += preview.length;
    debugSearch.appendRequestText(this.id, kind, text);
    debugSearch.appendRequestEvent(this.id, `${kind === 'answer' ? 'resposta' : 'pensamento'} +${text.length} chars`);
    this.section(kind === 'answer' ? 'resposta parcial' : 'pensamento parcial', [preview], ['stream', kind]);
  }

  toolCall(call: any) {
    if (!debugEnabled() || !call) return;
    const id = String(call.id || call.call_id || `${call.name}:${JSON.stringify(call.arguments ?? {})}`);
    if (this.seenToolCalls.has(id)) return;
    this.seenToolCalls.add(id);

    const name = call.name || call.function?.name || 'tool';
    const args = call.arguments ?? call.function?.arguments ?? {};
    const toolTag = debugSearch.tagForId(id, 'tool');
    debugSearch.appendToolCall(this.id, call);
    debugSearch.appendRequestEvent(this.id, `tool call: ${name} (#${toolTag})`);
    this.section('tool call', [
      kv('tag', `#${toolTag}`),
      kv('nome', name),
      kv('argumentos', truncate(formatArgs(args), config.debug.maxChars)),
    ], ['tool', name], [{ id, kind: 'tool' }]);
  }

  completed(result: DebugComplete = {}) {
    if (!debugEnabled() || this.closed) return;
    this.closed = true;

    for (const call of result.toolCalls || []) {
      this.toolCall(call);
    }

    const durationMs = Date.now() - this.startedAt;
    debugSearch.updateRequest(this.id, {
      status: result.status === 'failed' ? 'failed' : 'ok',
      usage: result.usage,
      finishReason: result.finishReason,
    });
    if (result.outputText) debugSearch.updateRequest(this.id, { answer: result.outputText });
    if (result.reasoningText) debugSearch.updateRequest(this.id, { reasoning: result.reasoningText });
    debugSearch.appendRequestEvent(this.id, `finalizado: ${result.finishReason || result.status || 'ok'} em ${durationMs}ms`);
    this.section('resposta final', [
      kv('status', result.status || 'ok'),
      result.finishReason ? kv('finish', result.finishReason) : null,
      kv('tempo', `${durationMs}ms`),
      result.usage ? kv('uso', compactJson(result.usage)) : null,
      result.outputText ? kv('texto', truncate(clean(result.outputText), config.debug.maxChars)) : null,
      result.reasoningText && mode !== 'basic'
        ? kv('pensamento', truncate(clean(result.reasoningText), config.debug.maxChars))
        : null,
      result.toolCalls?.length ? kv('tools chamadas', String(result.toolCalls.length)) : null,
    ], ['complete', result.status || 'ok', result.finishReason || '']);
  }

  failed(err: any) {
    if (!debugEnabled() || this.closed) return;
    this.closed = true;
    const translated = translateError(err);
    debugSearch.updateRequest(this.id, {
      status: 'failed',
      error: translated.summary,
    });
    debugSearch.appendRequestEvent(this.id, `erro: ${translated.summary}`);
    this.section('erro traduzido', [
      translated.summary,
      translated.hint,
      mode === 'raw' ? kv('erro bruto', String(err?.stack || err?.message || err)) : null,
    ], ['error', 'failed']);
  }

  private section(
    title: string,
    lines: Array<string | null | undefined>,
    tags: string[] = [],
    ids: Array<{ id: string; kind?: string }> = [{ id: this.id, kind: 'req' }],
  ) {
    const visible = lines.filter((line): line is string => Boolean(line && line.trim()));
    if (visible.length === 0) return;
    const record = debugSearch.record({
      scope: `Debug ${this.id.slice(0, 8)}`,
      title,
      lines: visible,
      tags,
      ids,
    });
    terminal.info(`Debug ${this.id.slice(0, 8)}`, paint(title, 'bold'), [
      `${paint('event:', 'dim')} #${record.eventTag} ${record.tags.slice(0, 6).map((tag) => paint(`#${tag}`, tag.includes('-') ? 'yellow' : 'blue')).join(' ')}`,
      ...visible,
    ]);
  }

  private block(title: string, text: string, tags: string[] = []) {
    const value = truncate(clean(text), mode === 'raw' ? Math.max(config.debug.maxChars, text.length) : config.debug.maxChars);
    if (!value) return;
    const record = debugSearch.record({
      scope: `Debug ${this.id.slice(0, 8)}`,
      title,
      lines: [value],
      tags,
      ids: [{ id: this.id, kind: 'req' }],
    });
    terminal.debug(`Debug ${this.id.slice(0, 8)}`, paint(title, 'bold'));
    console.log(`${paint('---', 'dim')} ${paint(`#${record.eventTag}`, 'magenta')} ${record.tags.slice(0, 6).map((tag) => paint(`#${tag}`, 'blue')).join(' ')}`);
    console.log(maskSensitive(value));
    console.log(paint('---', 'dim'));
  }
}

function kv(label: string, value: string): string {
  return `${paint(`${label}:`, 'dim')} ${value}`;
}

function summarizeInput(start: DebugStart): string {
  if (Array.isArray(start.messages)) {
    const byRole = start.messages.reduce<Record<string, number>>((acc, msg) => {
      const role = typeof msg?.role === 'string' ? msg.role : 'sem-role';
      acc[role] = (acc[role] || 0) + 1;
      return acc;
    }, {});
    return `${start.messages.length} mensagens (${Object.entries(byRole).map(([role, count]) => `${role}: ${count}`).join(', ')})`;
  }
  if (Array.isArray(start.input)) return `${start.input.length} itens Responses`;
  if (start.input !== undefined) return '1 item Responses';
  return 'vazia';
}

function summarizeTools(tools: any[] | undefined): string {
  if (!Array.isArray(tools) || tools.length === 0) return 'nenhuma';
  const names = tools
    .map((tool) => tool?.function?.name || tool?.name || tool?.type)
    .filter(Boolean);
  return names.length ? names.join(', ') : `${tools.length} tools sem nome`;
}

function translateError(err: any): { summary: string; hint: string } {
  const raw = String(err?.message || err || '');
  const lower = raw.toLowerCase();

  if (lower.includes('rate') || lower.includes('ratelimited')) {
    return {
      summary: 'A conta Qwen bateu limite de uso.',
      hint: 'O proxy vai evitar essa conta por um tempo. Use outra conta ou espere o prazo indicado pela Qwen.',
    };
  }
  if (lower.includes('chat is in progress') || lower.includes('in progress')) {
    return {
      summary: 'A Qwen ainda estava respondendo no mesmo chat.',
      hint: 'Isso costuma acontecer com chamadas paralelas. O proxy tenta retry; se repetir, reduza concorrencia ou use mais contas.',
    };
  }
  if (lower.includes('non-sse') || lower.includes('unexpected token') || lower.includes('<!doctype')) {
    return {
      summary: 'A Qwen respondeu algo que nao era stream SSE.',
      hint: 'Geralmente e login expirado, captcha, Cloudflare, rota alterada ou pagina HTML no lugar da API. Rode npm run login e tente de novo.',
    };
  }
  if (lower.includes('controller is already closed') || lower.includes('closed by the client')) {
    return {
      summary: 'O cliente fechou a conexao antes do fim.',
      hint: 'Normal quando a CLI cancela, fecha o terminal ou troca de requisicao. Nao e falha do modelo.',
    };
  }
  if (lower.includes('all accounts failed')) {
    return {
      summary: 'Nenhuma conta Qwen conseguiu atender a chamada.',
      hint: 'Veja se as contas estao logadas, sem cooldown e com acesso ao modelo pedido.',
    };
  }
  if (lower.includes('unauthorized') || lower.includes('api key')) {
    return {
      summary: 'A chave da API local nao passou.',
      hint: 'Confira API_KEY no .env e Authorization: Bearer <API_KEY> no cliente.',
    };
  }

  return {
    summary: raw || 'Erro desconhecido.',
    hint: 'Rode com QWENPROXY_DEBUG=full para ver a entrada, prompt e resposta resumidos.',
  };
}

function formatArgs(value: any): string {
  if (typeof value === 'string') return value;
  return compactJson(value);
}

function compactJson(value: any): string {
  try {
    return JSON.stringify(value, null, mode === 'raw' ? 2 : 0);
  } catch {
    return String(value);
  }
}

function clean(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/[ \f\v]+/g, ' ')
    .trim();
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 32))}... [cortado: ${text.length} chars]`;
}
