/*
 * File: executor.ts
 * Project: qwenproxy
 * Tool execution helpers - parseToolCallsFromContent and executeToolCalls
 */

import { v4 as uuidv4 } from 'uuid';
import type { ParsedToolCall, ToolCallResult, ToolContext } from './types.ts';
import { SchemaValidationError } from './schema.ts';
import { registry } from './registry.ts';
import { robustParseJSON } from '../utils/json.ts';
import { TOOL_CALL_START, TOOL_CALL_END } from '../constants.ts';

const TOOL_START_TAG = TOOL_CALL_START;
const TOOL_END_TAG = TOOL_CALL_END;

export function parseToolCallsFromContent(content: string): {
  textContent: string;
  toolCalls: ParsedToolCall[];
} {
  const toolCalls: ParsedToolCall[] = [];
  let remaining = content;
  let textContent = '';

  while (true) {
    const startIdx = remaining.indexOf(TOOL_START_TAG);
    if (startIdx === -1) {
      textContent += remaining;
      break;
    }

    textContent += remaining.substring(0, startIdx);

    const endIdx = remaining.indexOf(TOOL_END_TAG, startIdx + TOOL_START_TAG.length);
    if (endIdx === -1) {
      textContent += remaining.substring(startIdx);
      break;
    }

    const jsonStr = remaining
      .substring(startIdx + TOOL_START_TAG.length, endIdx)
      .trim();

    try {
      const parsed = robustParseJSON(jsonStr);
      if (!parsed) throw new Error('Failed to parse JSON');

      toolCalls.push({
        id: 'call_' + uuidv4(),
        name: parsed.name || '',
        arguments: parsed.arguments
          ? (typeof parsed.arguments === 'string' ? JSON.parse(parsed.arguments) : parsed.arguments)
          : (() => {
              const { name, ...rest } = parsed;
              return rest;
            })(),
      });
    } catch (e) {
      textContent += TOOL_START_TAG + jsonStr + TOOL_END_TAG;
    }

    remaining = remaining.substring(endIdx + TOOL_END_TAG.length);
  }

  return { textContent: textContent.trim(), toolCalls };
}

export async function executeToolCalls(
  toolCalls: ParsedToolCall[],
  context: ToolContext
): Promise<ToolCallResult[]> {
  return await Promise.all(
    toolCalls.map(async (tc) => {
      try {
        if (!registry.has(tc.name)) {
          return {
            toolCallId: tc.id,
            name: tc.name,
            result: JSON.stringify({ error: `Unknown tool: '${tc.name}'` }),
            isError: true,
          };
        }

        const result = await registry.execute(tc.name, tc.arguments, context);
        return {
          toolCallId: tc.id,
          name: tc.name,
          result,
          isError: false,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const isValidation = err instanceof SchemaValidationError;
        return {
          toolCallId: tc.id,
          name: tc.name,
          result: JSON.stringify({
            error: isValidation ? 'Schema validation failed' : 'Tool execution error',
            details: message,
            ...(isValidation ? { path: (err as SchemaValidationError).path } : {}),
          }),
          isError: true,
        };
      }
    })
  );
}
