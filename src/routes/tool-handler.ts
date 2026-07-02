import crypto from 'crypto';
import { robustParseJSON } from '../utils/json.js';
import type { FunctionToolDefinition } from '../tools/types.js';
import type { Message } from '../utils/types.js';

const contractCache = new Map<string, string>();
const manifestCache = new Map<string, string>();
const CACHE_MAX_ENTRIES = 64;

function toolCacheKey(tools: FunctionToolDefinition[], forcedToolName: string, extra?: string): string {
  const names = tools.map(t => getToolName(t)).join('|');
  return `${names}##${forcedToolName}##${extra ?? ''}`;
}

export function getToolFunction(tool: FunctionToolDefinition | any): any {
  return tool?.type === 'function' ? tool.function : tool;
}

export function getToolName(tool: FunctionToolDefinition | any): string {
  return getToolFunction(tool)?.name || '';
}

export function getToolDescription(tool: FunctionToolDefinition | any): string {
  return getToolFunction(tool)?.description || '';
}

export function getToolParameters(tool: FunctionToolDefinition | any): Record<string, any> {
  return getToolFunction(tool)?.parameters?.properties || {};
}

export function getRequiredParams(tool: FunctionToolDefinition | any): Set<string> {
  return new Set(getToolFunction(tool)?.parameters?.required || []);
}

export function compactPromptText(text: string, maxChars = 180): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}...`;
}

export function getForcedToolName(toolChoice: any): string {
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) {
    return toolChoice.function.name;
  }
  return '';
}

export function getToolChoiceMode(toolChoice: any): 'auto' | 'none' | 'required' | 'forced' {
  if (toolChoice === 'none') return 'none';
  if (toolChoice === 'required') return 'required';
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) return 'forced';
  return 'auto';
}

export function tokenizeForToolScoring(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of text.toLowerCase().match(/[a-z0-9_./-]+/g) || []) {
    if (token.length >= 3) tokens.add(token);
  }
  return tokens;
}

export function scoreToolForContext(tool: FunctionToolDefinition, contextText: string, forcedToolName: string, recentToolNames: Set<string>): number {
  const name = getToolName(tool);
  const description = getToolDescription(tool);
  const params = Object.keys(getToolParameters(tool));
  const tokens = tokenizeForToolScoring(contextText);
  let score = 0;

  if (forcedToolName && name === forcedToolName) score += 100;
  if (recentToolNames.has(name)) score += 35;

  const nameParts = name.toLowerCase().split(/[_./-]+/).filter(Boolean);
  for (const part of nameParts) {
    if (part.length >= 3 && tokens.has(part)) score += 20;
  }

  const toolText = `${name} ${description} ${params.join(' ')}`.toLowerCase();
  for (const token of tokens) {
    if (toolText.includes(token)) score += 2;
  }

  for (const param of params) {
    if (tokens.has(param.toLowerCase())) score += 3;
  }

  return score;
}

function splitToolText(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function collectSchemaText(schema: any): string[] {
  if (!schema || typeof schema !== 'object') return [];

  const values: string[] = [];
  if (typeof schema.description === 'string') values.push(schema.description);
  if (typeof schema.title === 'string') values.push(schema.title);
  if (typeof schema.const === 'string') values.push(schema.const);
  if (Array.isArray(schema.enum)) values.push(...schema.enum.filter((item: unknown): item is string => typeof item === 'string'));

  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, value] of Object.entries(schema.properties)) {
      values.push(key, ...collectSchemaText(value));
    }
  }

  if (schema.items) values.push(...collectSchemaText(schema.items));
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key])) {
      for (const item of schema[key]) values.push(...collectSchemaText(item));
    }
  }

  return values;
}

export function isFileMutationTool(tool: FunctionToolDefinition): boolean {
  const fn = getToolFunction(tool);
  const schema = fn?.parameters || {};
  const schemaText = collectSchemaText(schema);
  const tokens = new Set(splitToolText([getToolName(tool), getToolDescription(tool), ...schemaText].join(' ')));

  const hasFileTarget = ['file', 'files', 'path', 'filepath', 'uri', 'document', 'workspace', 'buffer'].some(token => tokens.has(token));
  const hasMutationVerb = [
    'append', 'apply', 'change', 'changes', 'create', 'delete', 'diff', 'edit', 'edits', 'insert', 'modify', 'move', 'overwrite',
    'patch', 'remove', 'rename', 'replace', 'save', 'str', 'truncate', 'update', 'write'
  ].some(token => tokens.has(token));
  const hasMutationPayload = [
    'content', 'diff', 'edit', 'edits', 'new', 'newtext', 'newstring', 'old', 'oldtext', 'oldstring', 'patch', 'replacement',
    'text', 'value'
  ].some(token => tokens.has(token));
  const hasReadOnlyVerb = ['read', 'list', 'search', 'find', 'grep', 'show', 'get', 'open', 'view', 'inspect', 'diagnostics', 'hover', 'definition', 'references']
    .some(token => tokens.has(token));

  return (
    hasFileTarget &&
    hasMutationVerb &&
    (hasMutationPayload || !hasReadOnlyVerb)
  );
}

function appendMissingFileMutationTools(selected: FunctionToolDefinition[], tools: FunctionToolDefinition[]): FunctionToolDefinition[] {
  const selectedNames = new Set(selected.map(getToolName));

  for (const tool of tools) {
    const name = getToolName(tool);
    if (!name || selectedNames.has(name) || !isFileMutationTool(tool)) continue;
    selected.push(tool);
    selectedNames.add(name);
  }

  return selected;
}

export function getRecentToolNames(messages: Message[]): Set<string> {
  const recentToolNames = new Set<string>();
  const recentMessages = messages.slice(-12);

  for (const msg of recentMessages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        if (call?.function?.name) recentToolNames.add(call.function.name);
      }
    }
    if ((msg.role === 'tool' || msg.role === 'function') && msg.name) {
      recentToolNames.add(msg.name);
    }
  }

  return recentToolNames;
}

export function selectCandidateTools(
  tools: FunctionToolDefinition[],
  contextText: string,
  forcedToolName = '',
  recentToolNames: Set<string> = new Set(),
  maxTools = 12
): FunctionToolDefinition[] {
  if (tools.length <= maxTools) return tools;

  const scored = tools
    .map(tool => ({ tool, score: scoreToolForContext(tool, contextText, forcedToolName, recentToolNames) }))
    .filter(entry => entry.score > 0 || (forcedToolName && getToolName(entry.tool) === forcedToolName))
    .sort((a, b) => b.score - a.score || getToolName(a.tool).localeCompare(getToolName(b.tool)));

  if (scored.length === 0) {
    return appendMissingFileMutationTools(tools.slice(0, maxTools), tools);
  }

  const selected = scored.slice(0, maxTools).map(entry => entry.tool);
  return appendMissingFileMutationTools(selected, tools);
}

export function buildCompactToolManifest(tools: FunctionToolDefinition[], forcedToolName = ''): string {
  if (tools.length === 0) return '';

  const cacheKey = toolCacheKey(tools, forcedToolName);
  const cached = manifestCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const lines = tools.map(tool => {
    const name = getToolName(tool);
    const description = compactPromptText(getToolDescription(tool), 140);
    const params = getToolParameters(tool);
    const required = getRequiredParams(tool);
    const signature = Object.entries(params)
      .map(([paramName, schema]: [string, any]) => {
        const optional = required.has(paramName) ? '' : '?';
        const type = schema?.type || 'any';
        return `${paramName}${optional}: ${type}`;
      })
      .join(', ');

    const marker = forcedToolName && name === forcedToolName ? ' [required]' : '';
    return `${name}(${signature})${description ? ` - ${description}` : ''}${marker}`;
  });

  const result = `[COMPACT TOOL MANIFEST]
${lines.join('\n')}`;
  if (manifestCache.size >= CACHE_MAX_ENTRIES) manifestCache.clear();
  manifestCache.set(cacheKey, result);
  return result;
}

export function buildToolCallContract(
  tools: FunctionToolDefinition[],
  forcedToolName = '',
  parallelToolCalls = true
): string {
  const cacheKey = toolCacheKey(tools, forcedToolName, parallelToolCalls ? 'p' : 's');
  const cached = contractCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const names = tools.map(getToolName).filter(Boolean);
  const toolList = names.length > 0 ? names.join(', ') : 'none';
  const forcedLine = forcedToolName
    ? `You MUST call exactly the tool "${forcedToolName}" unless the user request is impossible or unsafe. Do not call any other tool first.`
    : 'Only call a tool when the user request requires an external action.';
  const parallelLine = parallelToolCalls
    ? 'You may emit multiple tool call blocks only when the user explicitly asks for multiple independent actions.'
    : 'Emit at most one tool call block.';
  const fileMutationNames = tools.filter(isFileMutationTool).map(getToolName).filter(Boolean);
  const fileMutationLine = fileMutationNames.length > 0
    ? `Workspace file mutation capabilities detected in these exact tools: ${fileMutationNames.join(', ')}. When the user asks to create, edit, patch, replace, rename, move, delete, or save files, choose the matching tool by its description and parameter schema, not by a preferred generic name.`
    : '';

  const result = `[TOOL CALL CONTRACT - MUST FOLLOW]
Available tool names: ${toolList}
${fileMutationLine}
Format:

<tool_call>
{"name": "tool_name", "arguments": {"param_name": "value"}}
<` + `/tool_call>

Rules:
1. Use the exact tool name as provided by the client. Tool names vary by editor/integration; do not require names like read_file, edit_file, write_file, or apply_patch to exist.
2. Do not invent, guess, rename, or approximate tool names. If a tool capability exists under a different name, call that exact provided name.
3. Do not output raw JSON as a tool call.
4. ${forcedLine}
5. ${parallelLine}
6. If no tool is needed, do not emit any tool call block.
7. Put only valid JSON inside each <tool_call> block. No markdown fences, comments, or explanatory text inside the block.
8. If you emit a tool call, stop after the closing </tool_call> tag and wait for the tool response.`;
  if (contractCache.size >= CACHE_MAX_ENTRIES) contractCache.clear();
  contractCache.set(cacheKey, result);
  return result;
}

export function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function looksLikeUnwrappedToolCall(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  return /["']name["']\s*:/.test(trimmed) && /["']arguments["']\s*:/.test(trimmed);
}

export function parseUnwrappedToolCalls(text: string): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  if (!looksLikeUnwrappedToolCall(text)) return [];

  try {
    const parsed = robustParseJSON(text);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .filter(item => item && typeof item === 'object')
      .map((item: any) => {
        const name = item.name || item.function?.name || item.tool_name || item.tool;
        if (!name || typeof name !== 'string') return null;
        return {
          id: item.id || item.tool_call_id || `call_${crypto.randomUUID()}`,
          name,
          arguments: parseToolArguments(item.arguments || item.function?.arguments || item.args || item.parameters || item.input || {}),
        };
      })
      .filter((item: any): item is { id: string; name: string; arguments: Record<string, unknown> } => item !== null);
  } catch {
    return [];
  }
}
