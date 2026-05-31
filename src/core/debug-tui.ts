import readline from 'node:readline';
import { config } from './config.ts';
import { debugSearch, DebugRequestView } from './debug-search.ts';
import { maskSensitive, paint, terminal } from './terminal.ts';

let started = false;
let rl: readline.Interface | null = null;
let requestCursor = 0;
let view: 'home' | 'requests' | 'detail' | 'tags' | 'ids' = 'home';
let lastFilter = '';

export function startDebugTui(): void {
  if (started || config.debug.mode === 'off' || !process.stdin.isTTY || !process.stdout.isTTY) return;
  started = true;

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: paint('qwen-debug> ', 'magenta'),
  });
  readline.emitKeypressEvents(process.stdin, rl);

  terminal.info('Debug TUI', 'Interactive debug console enabled', [
    `${paint('d', 'cyan')} redraw dashboard`,
    `${paint('r', 'cyan')} requests  ${paint('t', 'cyan')} tags  ${paint('i', 'cyan')} ids`,
    `${paint('up/down', 'cyan')} select  ${paint('right/enter', 'cyan')} open  ${paint('left', 'cyan')} back`,
    `${paint('/texto', 'cyan')} search logs and tags`,
  ]);
  renderDashboard();
  rl.prompt();

  rl.on('line', (line) => {
    runCommand(line);
    rl?.prompt();
  });

  process.stdin.on('keypress', handleKeypress);

  rl.on('SIGINT', () => {
    rl?.close();
    process.kill(process.pid, 'SIGINT');
  });
}

export function stopDebugTui(): void {
  process.stdin.off('keypress', handleKeypress);
  rl?.close();
  rl = null;
  started = false;
}

export function refreshDebugPrompt(): void {
  if (!rl) return;
  rl.prompt(true);
}

function runCommand(raw: string): void {
  const input = raw.trim();
  if (!input) {
    if (view === 'requests') return openSelectedRequest();
    return renderDashboard();
  }
  if (input === 'help' || input === '?') return renderHelp();
  if (input === 'd' || input === 'ui' || input === 'dashboard') return renderDashboard();
  if (input === 'r' || input === 'requests' || input === 'reqs') return renderRequests();
  if (input === 't' || input === 'tags') return renderTags();
  if (input === 'i' || input === 'ids') return renderIds();
  if (input === 'open') return printSelectedRequest();
  if (input === 'next') return moveRequest(1);
  if (input === 'prev') return moveRequest(-1);
  if (input.startsWith('open ')) return printRequest(input.slice(5).trim());
  if (input === 'recent') return printRecords(debugSearch.recent(20));
  if (input.startsWith('recent ')) {
    const limit = Number.parseInt(input.slice('recent '.length), 10);
    return printRecords(debugSearch.recent(Number.isFinite(limit) ? limit : 20));
  }
  if (input.startsWith('tags ')) return renderTags(input.slice(4).trim());
  if (input.startsWith('ids ')) return renderIds(input.slice(3).trim());
  if (input.startsWith('show ')) return printResolved(input.slice(5).trim());
  if (input.startsWith('search ')) return printRecords(debugSearch.search(input.slice(7)));
  if (input.startsWith('/')) return renderSearch(input.slice(1));

  renderSearch(input);
}

function renderHelp(): void {
  clearView();
  drawHeader('QwenProxy Debug UI', 'atalhos e comandos');
  drawBox('Navegacao', [
    `${paint('d', 'cyan')} redesenha a tela atual`,
    `${paint('r', 'cyan')} requests  ${paint('t', 'cyan')} tags  ${paint('i', 'cyan')} IDs`,
    `${paint('cima/baixo', 'cyan')} seleciona request`,
    `${paint('direita/enter', 'cyan')} abre detalhe da request`,
    `${paint('esquerda', 'cyan')} volta para lista`,
  ]);
  drawBox('Busca', [
    `${paint('/termo', 'cyan')} busca em logs, tags, modelo, cliente e erro`,
    `${paint('open #req-001', 'cyan')} abre request por tag`,
    `${paint('show #acct-001', 'cyan')} resolve tag temporaria de ID`,
    `${paint('recent 20', 'cyan')} lista eventos recentes`,
  ]);
}

function handleKeypress(_str: string, key: any): void {
  if (!started || !key) return;
  if (key.ctrl && key.name === 'c') return;
  if (key.name === 'up') {
    moveRequest(-1);
    rl?.prompt();
  } else if (key.name === 'down') {
    moveRequest(1);
    rl?.prompt();
  } else if (key.name === 'right') {
    openSelectedRequest();
    rl?.prompt();
  } else if (key.name === 'left') {
    renderRequests();
    rl?.prompt();
  }
}

function moveRequest(delta: number): void {
  const requests = debugSearch.requestList();
  if (!requests.length) {
    renderEmpty('Nenhuma request capturada ainda.');
    return;
  }
  requestCursor = Math.max(0, Math.min(requestCursor + delta, requests.length - 1));
  if (view === 'detail') renderDetail(requests[requestCursor]);
  else renderRequests();
}

function printSelectedRequest(): void {
  const request = debugSearch.requestAt(requestCursor);
  if (!request) {
    console.log(paint('Nenhuma request capturada ainda.', 'warn'));
    return;
  }
  debugSearch.printRequest(request);
}

function openSelectedRequest(): void {
  const request = debugSearch.requestAt(requestCursor);
  if (!request) return renderEmpty('Nenhuma request capturada ainda.');
  renderDetail(request);
}

function printRequest(query: string): void {
  const request = debugSearch.findRequest(query);
  if (!request) {
    renderEmpty(`Request nao encontrada: ${query}`);
    return;
  }
  renderDetail(request);
}

function renderDashboard(): void {
  view = 'home';
  clearView();
  const requests = debugSearch.requestList();
  const running = requests.filter((request) => request.status === 'running').length;
  const failed = requests.filter((request) => request.status === 'failed').length;
  drawHeader('QwenProxy Debug UI', `modo ${config.debug.mode} | ${requests.length} requests | ${running} rodando | ${failed} erro(s)`);
  drawBox('Atalhos', [
    `${paint('r', 'cyan')} requests    ${paint('t', 'cyan')} tags    ${paint('i', 'cyan')} IDs    ${paint('h', 'cyan')} ajuda`,
    `${paint('cima/baixo', 'cyan')} seleciona request    ${paint('direita/enter', 'cyan')} abre detalhe`,
    `${paint('/texto', 'cyan')} busca    ${paint('d', 'cyan')} redesenha`,
  ]);
  if (requests.length) {
    drawBox('Ultimas requests', requestRows(requests.slice(0, 8)));
  } else {
    drawBox('Ultimas requests', ['Nenhuma request capturada ainda. Envie uma chamada pelo Zed/Codex/OpenCode e volte aqui.']);
  }
}

function renderRequests(): void {
  view = 'requests';
  clearView();
  const requests = debugSearch.requestList();
  if (!requests.length) {
    drawHeader('Requests', 'aguardando trafego');
    drawBox('Vazio', ['Nenhuma request capturada ainda.']);
    return;
  }
  requestCursor = Math.max(0, Math.min(requestCursor, requests.length - 1));
  drawHeader('Requests', `${requests.length} capturadas | use cima/baixo e direita/enter`);
  drawBox('Lista', requestRows(requests.slice(0, 18)));
}

function printRequestSummary(request: ReturnType<typeof debugSearch.requestList>[number], index: number, total: number): void {
  const statusColor = request.status === 'failed' ? 'red' : request.status === 'ok' ? 'green' : 'yellow';
  const selected = index === requestCursor ? paint('>', 'magenta') : ' ';
  console.log(`${selected} ${paint(`${index + 1}/${total}`, 'dim')} ${paint(`#${request.tag}`, 'yellow')} ${paint(request.status, statusColor)} ${request.route} ${request.model} ${request.stream ? 'SSE' : ''}`);
}

function renderDetail(request: DebugRequestView): void {
  view = 'detail';
  clearView();
  const statusColor = request.status === 'failed' ? 'red' : request.status === 'ok' ? 'green' : 'yellow';
  const duration = `${request.updatedAt - request.startedAt}ms`;
  drawHeader(`Request #${request.tag}`, `${request.route} | ${request.model} | ${request.stream ? 'SSE' : 'non-stream'}`);
  drawBox('Resumo', [
    `${paint('status', 'dim')}: ${paint(request.status, statusColor)}    ${paint('tempo', 'dim')}: ${duration}`,
    `${paint('cliente', 'dim')}: ${maskSensitive(request.client)}    ${paint('conta', 'dim')}: ${request.accountTag ? `#${request.accountTag}` : '-'} ${maskSensitive(request.account || '')}`,
    `${paint('finish', 'dim')}: ${request.finishReason || '-'}    ${paint('usage', 'dim')}: ${request.usage ? compactJson(request.usage) : '-'}`,
    request.error ? `${paint('erro', 'red')}: ${maskSensitive(request.error)}` : '',
  ].filter(Boolean));
  drawBox('Entrada traduzida', formatInput(request.inputPreview, 8));
  drawBox('Resposta', textLines(request.answer || '(sem texto ainda)', 14));
  if (request.reasoning) drawBox('Pensamento', textLines(request.reasoning, 8));
  if (request.toolCalls.length) drawBox('Tool calls', textLines(prettyJson(request.toolCalls), 12));
  drawBox('Timeline', request.events.slice(-10).map((event) => maskSensitive(event)));
}

function renderTags(filter = ''): void {
  view = 'tags';
  lastFilter = filter;
  clearView();
  drawHeader('Tags', filter ? `filtro: ${filter}` : 'tags indexadas');
  const tags = debugSearch.tags(filter).slice(0, 28);
  drawBox('Mais usadas', tags.length ? tags.map((item) => `${paint(`#${item.tag}`, item.tag.includes('-') ? 'yellow' : 'blue')} ${paint(String(item.count).padStart(3), 'dim')}`) : ['Nenhuma tag encontrada.']);
}

function renderIds(filter = ''): void {
  view = 'ids';
  lastFilter = filter;
  clearView();
  drawHeader('IDs', filter ? `filtro: ${filter}` : 'tags temporarias');
  const aliases = debugSearch.aliases(filter).slice(0, 28);
  drawBox('Aliases', aliases.length ? aliases.map((item) => `${paint(`#${item.tag}`, 'yellow')} ${paint('=>', 'dim')} ${maskSensitive(item.id)}`) : ['Nenhum ID indexado ainda.']);
}

function renderSearch(query: string): void {
  lastFilter = query;
  clearView();
  drawHeader('Busca', query || 'eventos recentes');
  const records = debugSearch.search(query, 12);
  if (!records.length) return drawBox('Resultado', ['Nenhum evento encontrado.']);
  drawBox('Resultado', records.map((record) => {
    const time = new Date(record.at).toISOString().slice(11, 19);
    return `${paint(time, 'dim')} ${paint(`#${record.eventTag}`, 'magenta')} ${record.scope} ${paint(record.title, 'cyan')} ${record.tags.slice(0, 4).map((tag) => `#${tag}`).join(' ')}`;
  }));
}

function renderEmpty(message: string): void {
  clearView();
  drawHeader('QwenProxy Debug UI', 'sem dados para mostrar');
  drawBox('Aviso', [message]);
}

function printTags(filter: string): void {
  const tags = debugSearch.tags(filter);
  if (!tags.length) {
    console.log(paint('Nenhuma tag encontrada.', 'warn'));
    return;
  }
  for (const item of tags) {
    console.log(`${paint(`#${item.tag}`, 'blue')} ${paint(String(item.count).padStart(3), 'dim')}`);
  }
}

function printIds(filter: string): void {
  const aliases = debugSearch.aliases(filter);
  if (!aliases.length) {
    console.log(paint('Nenhum ID indexado ainda.', 'warn'));
    return;
  }
  for (const item of aliases) {
    console.log(`${paint(`#${item.tag}`, 'yellow')} ${paint('=>', 'dim')} ${item.id}`);
  }
}

function printResolved(tag: string): void {
  const id = debugSearch.resolveTag(tag);
  if (!id) {
    console.log(paint(`Tag nao encontrada: ${tag}`, 'warn'));
    return;
  }
  console.log(`${paint(tag.startsWith('#') ? tag : `#${tag}`, 'yellow')} ${paint('=>', 'dim')} ${id}`);
}

function printRecords(records: ReturnType<typeof debugSearch.search>): void {
  if (!records.length) {
    console.log(paint('Nenhum evento encontrado.', 'warn'));
    return;
  }
  console.log('');
  for (const record of records) {
    debugSearch.printRecord(record);
  }
  console.log('');
}

function requestRows(requests: DebugRequestView[]): string[] {
  const total = debugSearch.requestList().length;
  return requests.map((request, index) => {
    const absoluteIndex = index;
    const selected = absoluteIndex === requestCursor ? paint('>', 'magenta') : ' ';
    const statusColor = request.status === 'failed' ? 'red' : request.status === 'ok' ? 'green' : 'yellow';
    const duration = `${request.updatedAt - request.startedAt}ms`.padStart(7);
    return `${selected} ${paint(`${absoluteIndex + 1}/${total}`.padEnd(6), 'dim')} ${paint(`#${request.tag}`.padEnd(9), 'yellow')} ${paint(request.status.padEnd(7), statusColor)} ${duration} ${request.route.padEnd(16)} ${truncate(request.model, 20).padEnd(20)} ${request.stream ? 'SSE' : 'json'}`;
  });
}

function clearView(): void {
  process.stdout.write('\x1b[2J\x1b[H');
}

function drawHeader(title: string, subtitle: string): void {
  const width = terminalWidth();
  console.log(paint('='.repeat(width), 'dim'));
  console.log(`${paint(title, 'bold')} ${paint('-', 'dim')} ${maskSensitive(subtitle)}`);
  console.log(paint('='.repeat(width), 'dim'));
}

function drawBox(title: string, lines: string[]): void {
  const width = terminalWidth();
  const inner = Math.max(20, width - 4);
  console.log(`${paint('+', 'dim')}${paint('-'.repeat(width - 2), 'dim')}${paint('+', 'dim')}`);
  console.log(`${paint('|', 'dim')} ${paint(title.padEnd(inner), 'bold')} ${paint('|', 'dim')}`);
  console.log(`${paint('+', 'dim')}${paint('-'.repeat(width - 2), 'dim')}${paint('+', 'dim')}`);
  for (const line of lines.length ? lines : ['']) {
    for (const part of wrapAnsi(maskSensitive(line), inner)) {
      console.log(`${paint('|', 'dim')} ${part}${' '.repeat(Math.max(0, inner - visibleLength(part)))} ${paint('|', 'dim')}`);
    }
  }
  console.log(`${paint('+', 'dim')}${paint('-'.repeat(width - 2), 'dim')}${paint('+', 'dim')}`);
}

function formatInput(value: unknown, limit: number): string[] {
  if (value === undefined) return ['(sem entrada capturada)'];
  if (!Array.isArray(value)) return textLines(prettyJson(value), limit);
  const lines = value.map((item, index) => {
    const role = typeof item?.role === 'string' ? item.role : item?.type || 'item';
    const content = typeof item?.content === 'string'
      ? item.content
      : Array.isArray(item?.content)
        ? item.content.map((part: any) => part?.text || part?.content || part?.type || '').filter(Boolean).join(' ')
        : prettyJson(item?.content ?? item);
    return `[${index}] ${role}: ${truncate(maskSensitive(String(content)).replace(/\s+/g, ' '), 180)}`;
  });
  return lines.slice(0, limit);
}

function textLines(value: string, limit: number): string[] {
  return maskSensitive(value).split('\n').flatMap((line) => line.trim() ? [line] : []).slice(0, limit);
}

function prettyJson(value: unknown): string {
  try {
    return maskSensitive(JSON.stringify(value, null, 2));
  } catch {
    return maskSensitive(String(value));
  }
}

function compactJson(value: unknown): string {
  return truncate(prettyJson(value).replace(/\s+/g, ' '), 140);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function terminalWidth(): number {
  return Math.min(120, Math.max(72, process.stdout.columns || 96));
}

function wrapAnsi(value: string, width: number): string[] {
  const words = value.split(/(\s+)/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (visibleLength(current) + visibleLength(word) > width && current.trim()) {
      lines.push(current.trimEnd());
      current = word.trimStart();
    } else {
      current += word;
    }
  }
  if (current || lines.length === 0) lines.push(current.trimEnd());
  return lines;
}

function visibleLength(value: string): number {
  return value.replace(/\x1b\[[0-9;]*m/g, '').length;
}
