/*
 * File: registry.ts
 * Project: qwenproxy
 * Tool registry with register/lookup and OpenAI-compatible schema export
 */

import type {
  FunctionToolDefinition,
  JsonSchema,
  ToolContext,
  ToolHandler,
  ToolRegistration,
} from "./types";
import { validateAgainstSchema, SchemaValidationError } from "./schema";
import {
  logger,
  isToolcallDebugEnabled,
  isToolcallErrorDebugEnabled,
} from "../core/logger.js";

/**
 * Central tool registry. Tools are registered at startup and looked up by name
 * during the execution loop.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();

  /**
   * Register a new tool.
   * @param name        Unique tool name (must match the function name the LLM will emit)
   * @param description Human-readable description (sent to the LLM)
   * @param parameters  JSON Schema describing the tool's parameters
   * @param handler     Async function that executes the tool
   * @param strict      When true, additionalProperties:false is enforced and
   *                    missing required fields are rejected (default true)
   */
  register<TArgs = any, TResult = any>(
    name: string,
    description: string,
    parameters: JsonSchema,
    handler: ToolHandler<TArgs, TResult>,
    strict = true,
  ): void {
    if (this.tools.has(name)) {
      throw new Error(`Tool '${name}' is already registered`);
    }

    // If strict mode, ensure the schema enforces additionalProperties: false
    const enforcedParams = strict
      ? { ...parameters, additionalProperties: false }
      : parameters;

    this.tools.set(name, {
      name,
      description,
      parameters: enforcedParams,
      strict,
      handler: handler as ToolHandler,
    });

    if (isToolcallDebugEnabled()) {
      logger.debug("[registry] tool registered", {
        name,
        description: description.substring(0, 100),
        strict,
        hasProperties: !!parameters.properties,
        requiredParams: parameters.required || [],
        totalTools: this.tools.size,
      });
    }
  }

  /**
   * Unregister a tool by name. Useful for testing.
   */
  unregister(name: string): boolean {
    const result = this.tools.delete(name);
    if (isToolcallDebugEnabled()) {
      logger.debug("[registry] tool unregistered", {
        name,
        success: result,
        remainingTools: this.tools.size,
      });
    }
    return result;
  }

  /**
   * Look up a tool by name. Returns undefined if not found.
   */
  get(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  /**
   * Check whether a tool with the given name exists.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Return all registered tool names.
   */
  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Return the OpenAI-compatible tool definitions array
   * (for inclusion in the `tools` field of the request body sent to the LLM).
   */
  toOpenAITools(): FunctionToolDefinition[] {
    const defs: FunctionToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      defs.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: tool.strict,
        },
      });
    }

    if (isToolcallDebugEnabled()) {
      logger.debug("[registry] toOpenAITools: exported", {
        count: defs.length,
        names: defs.map((d) => d.function.name),
      });
    }

    return defs;
  }

  /**
   * Validate a tool call's arguments against the registered schema, then
   * invoke the handler. Returns a serialised result string.
   *
   * @throws SchemaValidationError if validation fails
   * @throws Error if the tool is not found
   */
  async execute(
    toolName: string,
    rawArgs: Record<string, unknown>,
    context: ToolContext,
  ): Promise<string> {
    const registration = this.tools.get(toolName);
    if (!registration) {
      if (isToolcallDebugEnabled()) {
        logger.debug("[registry] execute: tool not found", {
          toolName,
          availableTools: Array.from(this.tools.keys()),
        });
      }
      throw new Error(`Unknown tool: '${toolName}'`);
    }

    if (isToolcallDebugEnabled()) {
      logger.debug("[registry] execute: validating args", {
        toolName,
        rawArgs,
        schemaProperties: Object.keys(registration.parameters.properties || {}),
        requiredParams: registration.parameters.required || [],
      });
    }

    // Strict validation
    let validatedArgs: Record<string, unknown>;
    try {
      validatedArgs = validateAgainstSchema(
        rawArgs,
        registration.parameters,
        `$.${toolName}`,
      ) as Record<string, unknown>;

      if (isToolcallDebugEnabled()) {
        logger.debug("[registry] execute: validation passed", {
          toolName,
          validatedArgs,
        });
      }
    } catch (err) {
      if (isToolcallErrorDebugEnabled()) {
        logger.debug("[registry] execute: validation failed", {
          toolName,
          rawArgs,
          error: err instanceof Error ? err.message : String(err),
          path: err instanceof SchemaValidationError ? err.path : undefined,
        });
      }
      throw err;
    }

    const startTime = Date.now();
    const result = await registration.handler(validatedArgs, context);
    const duration = Date.now() - startTime;

    if (isToolcallDebugEnabled()) {
      logger.debug("[registry] execute: handler completed", {
        toolName,
        duration,
        resultType: typeof result,
        resultPreview:
          typeof result === "string"
            ? result.substring(0, 200)
            : JSON.stringify(result).substring(0, 200),
      });
    }

    // Serialize result
    if (typeof result === "string") {
      return result;
    }
    return JSON.stringify(result, null, 2);
  }
}

/**
 * Singleton registry instance shared across the application.
 */
export const registry = new ToolRegistry();
