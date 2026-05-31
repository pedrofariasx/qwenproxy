import { maskSensitive, paint } from './terminal.ts';

type DebugId = {
  id: string;
  kind?: string;
};

type DebugRecordInput = {
  scope: string;
  title: string;
  lines?: string[];
  tags?: string[];
  ids?: DebugId[];
};

export type DebugRecord = {
  seq: number;
  at: number;
  eventTag: string;
  scope: string;
  title: string;
  lines: string[];
  tags: string[];
  ids: DebugId[];
  text: string;
};

export type DebugRequestView = {
  id: string;
  tag: string;
  route: string;
  client: string;
  model: string;
  stream: boolean;
  status: 'running' | 'ok' | 'failed';
  startedAt: number;
  updatedAt: number;
  account?: string;
  accountTag?: string;
  inputPreview?: unknown;
  promptPreview?: string;
  answer: string;
  reasoning: string;
  toolCalls: unknown[];
  usage?: unknown;
  finishReason?: string;
  error?: string;
  events: string[];
};

const MAX_RECORDS = 800;
const MAX_TEXT = 12000;

class DebugSearchIndex {
  private records: DebugRecord[] = [];
  private seq = 0;
  private idSeq = 0;
  private idToTag = new Map<string, string>();
  private tagToId = new Map<string, string>();
  private requests = new Map<string, DebugRequestView>();

  record(input: DebugRecordInput): DebugRecord {
    const idTags = (input.ids || [])
      .filter((item) => item.id.trim())
      .map((item) => this.tagForId(item.id, item.kind));
    const tags = unique([
      `scope:${slug(input.scope)}`,
      `event:${slug(input.title)}`,
      ...normalizeTags(input.tags || []),
      ...idTags,
    ]);
    const record: DebugRecord = {
      seq: ++this.seq,
      at: Date.now(),
      eventTag: `evt-${this.seq.toString(36).padStart(4, '0')}`,
      scope: input.scope,
      title: input.title,
      lines: input.lines || [],
      tags,
      ids: input.ids || [],
      text: '',
    };
    record.text = [
      record.eventTag,
      record.scope,
      record.title,
      ...record.lines.map(maskSensitive),
      ...record.tags,
      ...record.ids.map((item) => item.id),
    ].join(' ').toLowerCase();

    this.records.push(record);
    if (this.records.length > MAX_RECORDS) this.records.shift();
    return record;
  }

  startRequest(input: {
    id: string;
    route: string;
    client?: string | null;
    model?: string;
    stream?: boolean;
    inputPreview?: unknown;
  }): DebugRequestView {
    const tag = this.tagForId(input.id, 'req');
    const current = this.requests.get(input.id);
    const request: DebugRequestView = current || {
      id: input.id,
      tag,
      route: input.route,
      client: input.client || 'cliente desconhecido',
      model: input.model || 'nao informado',
      stream: Boolean(input.stream),
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      answer: '',
      reasoning: '',
      toolCalls: [],
      events: [],
    };
    request.route = input.route;
    request.client = input.client || request.client;
    request.model = input.model || request.model;
    request.stream = Boolean(input.stream);
    request.inputPreview = input.inputPreview;
    request.updatedAt = Date.now();
    this.requests.set(input.id, request);
    return request;
  }

  updateRequest(id: string, patch: Partial<DebugRequestView>): void {
    const request = this.requests.get(id);
    if (!request) return;
    Object.assign(request, patch, { updatedAt: Date.now() });
  }

  appendRequestEvent(id: string, event: string): void {
    const request = this.requests.get(id);
    if (!request) return;
    request.events.push(event);
    if (request.events.length > 120) request.events.shift();
    request.updatedAt = Date.now();
  }

  appendRequestText(id: string, kind: 'answer' | 'reasoning', text: string): void {
    const request = this.requests.get(id);
    if (!request || !text) return;
    request[kind] = trimLong(`${request[kind]}${text}`, MAX_TEXT);
    request.updatedAt = Date.now();
  }

  appendToolCall(id: string, call: unknown): void {
    const request = this.requests.get(id);
    if (!request) return;
    request.toolCalls.push(call);
    if (request.toolCalls.length > 80) request.toolCalls.shift();
    request.updatedAt = Date.now();
  }

  requestList(): DebugRequestView[] {
    return [...this.requests.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  requestAt(cursor: number): DebugRequestView | undefined {
    const requests = this.requestList();
    if (!requests.length) return undefined;
    return requests[Math.max(0, Math.min(cursor, requests.length - 1))];
  }

  findRequest(query: string): DebugRequestView | undefined {
    const needle = stripHash(query).toLowerCase();
    const realId = this.resolveTag(needle);
    return this.requestList().find((request) => {
      return request.id === realId
        || request.id.toLowerCase().includes(needle)
        || request.tag === needle
        || request.model.toLowerCase().includes(needle)
        || request.client.toLowerCase().includes(needle);
    });
  }

  tagForId(id: string, kind = 'id'): string {
    const key = id.trim();
    const existing = this.idToTag.get(key);
    if (existing) return existing;
    const tag = `${slug(kind)}-${(++this.idSeq).toString(36).padStart(3, '0')}`;
    this.idToTag.set(key, tag);
    this.tagToId.set(tag, key);
    return tag;
  }

  resolveTag(tag: string): string | undefined {
    return this.tagToId.get(stripHash(tag));
  }

  aliases(filter = ''): Array<{ tag: string; id: string }> {
    const needle = filter.trim().toLowerCase();
    return [...this.tagToId.entries()]
      .map(([tag, id]) => ({ tag, id }))
      .filter((item) => !needle || item.tag.includes(needle) || item.id.toLowerCase().includes(needle))
      .slice(-80);
  }

  tags(filter = ''): Array<{ tag: string; count: number }> {
    const needle = stripHash(filter).toLowerCase();
    const counts = new Map<string, number>();
    for (const record of this.records) {
      for (const tag of record.tags) {
        if (!needle || tag.includes(needle)) {
          counts.set(tag, (counts.get(tag) || 0) + 1);
        }
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 80);
  }

  recent(limit = 20): DebugRecord[] {
    return this.records.slice(-Math.max(1, limit)).reverse();
  }

  search(query: string, limit = 30): DebugRecord[] {
    const terms = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .map(stripHash)
      .filter(Boolean);
    if (terms.length === 0) return this.recent(limit);

    return this.records
      .filter((record) => terms.every((term) => record.text.includes(term)))
      .slice(-Math.max(1, limit))
      .reverse();
  }

  printRecord(record: DebugRecord): void {
    const time = new Date(record.at).toISOString().slice(11, 19);
    console.log(`${paint(time, 'dim')} ${paint(`#${record.eventTag}`, 'magenta')} ${paint(record.scope, 'bold')} ${paint(record.title, 'cyan')}`);
    console.log(`  ${paint('tags:', 'dim')} ${record.tags.map((tag) => paint(`#${tag}`, tag.includes('-') ? 'yellow' : 'blue')).join(' ')}`);
    for (const id of record.ids) {
      const tag = this.tagForId(id.id, id.kind);
      console.log(`  ${paint(`#${tag}`, 'yellow')} ${paint('=>', 'dim')} ${maskSensitive(id.id)}`);
    }
    for (const line of record.lines.slice(0, 8)) {
      console.log(`  ${paint('-', 'dim')} ${maskSensitive(line)}`);
    }
  }

  printRequest(request: DebugRequestView): void {
    const duration = `${request.updatedAt - request.startedAt}ms`;
    const statusColor = request.status === 'failed' ? 'red' : request.status === 'ok' ? 'green' : 'yellow';
    console.log('');
    console.log(`${paint(`#${request.tag}`, 'yellow')} ${paint(request.route, 'cyan')} ${paint(request.status, statusColor)} ${paint(duration, 'dim')}`);
    console.log(`  ${paint('cliente:', 'dim')} ${maskSensitive(request.client)}  ${paint('modelo:', 'dim')} ${request.model}  ${paint('stream:', 'dim')} ${request.stream ? 'SSE' : 'nao'}`);
    if (request.account || request.accountTag) {
      console.log(`  ${paint('conta:', 'dim')} ${request.accountTag ? paint(`#${request.accountTag}`, 'yellow') : ''} ${maskSensitive(request.account || '')}`);
    }
    if (request.finishReason || request.usage) {
      console.log(`  ${paint('final:', 'dim')} ${request.finishReason || 'ok'} ${request.usage ? prettyInline(request.usage) : ''}`);
    }
    if (request.error) console.log(`  ${paint('erro:', 'red')} ${maskSensitive(request.error)}`);
    printBlock('entrada traduzida', translateInput(request.inputPreview));
    printBlock('prompt', request.promptPreview || '');
    printBlock('pensamento', request.reasoning);
    printBlock('resposta', request.answer);
    if (request.toolCalls.length) printBlock('tool calls', prettyJson(request.toolCalls));
    if (request.events.length) printBlock('linha do tempo', request.events.slice(-25).join('\n'));
    console.log('');
  }
}

export const debugSearch = new DebugSearchIndex();

function normalizeTags(tags: string[]): string[] {
  return tags.map((tag) => slug(stripHash(tag))).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stripHash(value: string): string {
  return value.trim().replace(/^#/, '');
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function trimLong(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n... [truncado na TUI: ${value.length} chars]`;
}

function prettyInline(value: unknown): string {
  const json = prettyJson(value).replace(/\s+/g, ' ').trim();
  return json.length > 180 ? `${json.slice(0, 177)}...` : json;
}

function prettyJson(value: unknown): string {
  try {
    return maskSensitive(JSON.stringify(value, null, 2));
  } catch {
    return maskSensitive(String(value));
  }
}

function translateInput(value: unknown): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const role = typeof item?.role === 'string' ? item.role : item?.type || 'item';
      const content = typeof item?.content === 'string'
        ? item.content
        : Array.isArray(item?.content)
          ? item.content.map((part: any) => part?.text || part?.content || part?.type || '').filter(Boolean).join(' ')
          : '';
      return `[${index}] ${role}: ${maskSensitive(String(content)).slice(0, 800)}`;
    }).join('\n');
  }
  return prettyJson(value);
}

function printBlock(title: string, value: string): void {
  const clean = maskSensitive(value || '').trim();
  if (!clean) return;
  console.log(`  ${paint(title, 'bold')}`);
  for (const line of clean.split('\n').slice(0, 80)) {
    console.log(`    ${line}`);
  }
}
