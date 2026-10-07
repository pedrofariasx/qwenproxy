import { test } from 'node:test';
import assert from 'node:assert';
import { buildToolCallContract, selectCandidateTools } from '../../routes/tool-handler.js';
import type { FunctionToolDefinition } from '../../tools/types.js';

function tool(name: string, description: string, properties: Record<string, any> = {}): FunctionToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
      },
    },
  };
}

test('selectCandidateTools preserves file mutation tools for editor integrations', () => {
  const tools: FunctionToolDefinition[] = [
    tool('read_file', 'Read a file', { path: { type: 'string' } }),
    tool('list_files', 'List files', { path: { type: 'string' } }),
    tool('search_symbols', 'Search code symbols', { query: { type: 'string' } }),
    tool('diagnostics', 'Get diagnostics', { path: { type: 'string' } }),
    tool('workspace_context', 'Get workspace context', { query: { type: 'string' } }),
    tool('terminal_output', 'Read terminal output', { id: { type: 'string' } }),
    tool('open_tabs', 'List open tabs', {}),
    tool('project_info', 'Describe project info', {}),
    tool('git_status', 'Show git status', {}),
    tool('references', 'Find references', { symbol: { type: 'string' } }),
    tool('definition', 'Go to definition', { symbol: { type: 'string' } }),
    tool('hover', 'Show hover information', { symbol: { type: 'string' } }),
    tool('edit_file', 'Edit a file replacing text', {
      path: { type: 'string' },
      oldText: { type: 'string' },
      newText: { type: 'string' },
    }),
    tool('write_file', 'Write file content', {
      path: { type: 'string' },
      content: { type: 'string' },
    }),
  ];

  const selected = selectCandidateTools(tools, 'Explique a arquitetura do projeto', '', new Set(), 12);
  const names = selected.map(t => t.function.name);

  assert.ok(names.includes('edit_file'), 'edit_file must not be pruned from editor tool lists');
  assert.ok(names.includes('write_file'), 'write_file must not be pruned from editor tool lists');
});

test('selectCandidateTools preserves file mutation tools with integration-specific names', () => {
  const tools: FunctionToolDefinition[] = [
    tool('workspace.read', 'Read workspace document', { uri: { type: 'string' } }),
    tool('project_symbols', 'Search project symbols', { query: { type: 'string' } }),
    tool('diagnostics', 'Get diagnostics', { uri: { type: 'string' } }),
    tool('terminal_output', 'Read terminal output', { id: { type: 'string' } }),
    tool('open_tabs', 'List open tabs', {}),
    tool('project_info', 'Describe project info', {}),
    tool('git_status', 'Show git status', {}),
    tool('references', 'Find references', { symbol: { type: 'string' } }),
    tool('definition', 'Go to definition', { symbol: { type: 'string' } }),
    tool('hover', 'Show hover information', { symbol: { type: 'string' } }),
    tool('selection_context', 'Get current selection', {}),
    tool('language_server', 'Call language server', { method: { type: 'string' } }),
    tool('zed.workspace.apply_edits', 'Apply text edits to a workspace document', {
      uri: { type: 'string', description: 'Document URI or file path' },
      edits: {
        type: 'array',
        description: 'Text edits to apply to the file',
        items: { type: 'object' },
      },
    }),
    tool('buffer_replace', 'Replace text in an editor buffer', {
      documentUri: { type: 'string' },
      old_string: { type: 'string' },
      replacement: { type: 'string' },
    }),
  ];

  const selected = selectCandidateTools(tools, 'Explique a arquitetura do projeto', '', new Set(), 12);
  const names = selected.map(t => t.function.name);

  assert.ok(names.includes('zed.workspace.apply_edits'));
  assert.ok(names.includes('buffer_replace'));
});

test('buildToolCallContract explicitly lists file editing tools', () => {
  const tools = [
    tool('read_file', 'Read a file', { path: { type: 'string' } }),
    tool('edit_file', 'Edit a file replacing text', {
      path: { type: 'string' },
      oldText: { type: 'string' },
      newText: { type: 'string' },
    }),
  ];

  const contract = buildToolCallContract(tools);

  assert.match(contract, /Workspace file mutation capabilities/);
  assert.match(contract, /edit_file/);
});

test('buildToolCallContract avoids assuming generic tool names', () => {
  const tools = [
    tool('workspace.read', 'Read workspace document', { uri: { type: 'string' } }),
    tool('zed.workspace.apply_edits', 'Apply text edits to a workspace document', {
      uri: { type: 'string', description: 'Document URI or file path' },
      edits: { type: 'array', description: 'Text edits to apply to the file' },
    }),
  ];

  const contract = buildToolCallContract(tools);

  assert.match(contract, /Tool names vary by editor\/integration/);
  assert.match(contract, /zed\.workspace\.apply_edits/);
  assert.doesNotMatch(contract, /should be used when modifying workspace files: edit_file/);
});
