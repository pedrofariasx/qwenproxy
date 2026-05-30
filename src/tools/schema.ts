/*
 * File: schema.ts
 * Project: qwenproxy
 * Strict JSON Schema validator for tool calling
 */

import type { JsonSchema } from './types';

/**
 * Error thrown when schema validation fails.
 */
export class SchemaValidationError extends Error {
  public readonly path: string;
  public readonly value: unknown;

  constructor(message: string, path: string, value?: unknown) {
    super(message);
    this.name = 'SchemaValidationError';
    this.path = path;
    this.value = value;
  }
}

/**
 * Validates a value against a JSON Schema with strict type checking.
 * Throws SchemaValidationError on failure.
 * Returns the validated (possibly coerced) value on success.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path: string = '$'
): unknown {
  // Handle nullable schemas
  if (schema.nullable && (value === null || value === undefined)) {
    return value;
  }

  let result: unknown;

  switch (schema.type) {
    case 'object':
      result = validateObject(value, schema, path);
      break;
    case 'array':
      result = validateArray(value, schema, path);
      break;
    case 'string':
      result = validateString(value, schema, path);
      break;
    case 'number':
    case 'integer':
      result = validateNumber(value, schema, path);
      break;
    case 'boolean':
      result = validateBoolean(value, schema, path);
      break;
    case 'null':
      if (value !== null) {
        throw new SchemaValidationError(
          `Expected null at ${path}, got ${typeof value}`,
          path,
          value
        );
      }
      result = null;
      break;
    default:
      result = value;
      break;
  }

  // Validate combinators (anyOf, oneOf, allOf, not) after type validation.
  // These are independent assertions per JSON Schema spec.
  validateCombinators(value, schema, path);

  return result;
}

/**
 * Validates JSON Schema combinators: anyOf, oneOf, allOf, not.
 * These are independent of the `type` keyword and are checked at every level.
 * @throws SchemaValidationError if any combinator check fails
 */
function validateCombinators(
  value: unknown,
  schema: JsonSchema,
  path: string
): void {
  // anyOf: value must match AT LEAST one sub-schema
  if (schema.anyOf && schema.anyOf.length > 0) {
    let passed = false;
    for (let i = 0; i < schema.anyOf.length; i++) {
      try {
        validateAgainstSchema(value, schema.anyOf[i], `${path}.anyOf[${i}]`);
        passed = true;
        break;
      } catch {
        // try next sub-schema
      }
    }
    if (!passed) {
      throw new SchemaValidationError(
        `Value at ${path} does not match any schema in anyOf (${schema.anyOf.length} alternatives tried)`,
        path,
        value
      );
    }
  }

  // oneOf: value must match EXACTLY ONE sub-schema
  if (schema.oneOf && schema.oneOf.length > 0) {
    let matchCount = 0;
    for (let i = 0; i < schema.oneOf.length; i++) {
      try {
        validateAgainstSchema(value, schema.oneOf[i], `${path}.oneOf[${i}]`);
        matchCount++;
      } catch {
        // does not match this sub-schema
      }
    }
    if (matchCount !== 1) {
      throw new SchemaValidationError(
        `Value at ${path} matches ${matchCount} schemas in oneOf (expected exactly 1)`,
        path,
        value
      );
    }
  }

  // allOf: value must match ALL sub-schemas
  if (schema.allOf && schema.allOf.length > 0) {
    const errors: string[] = [];
    for (let i = 0; i < schema.allOf.length; i++) {
      try {
        validateAgainstSchema(value, schema.allOf[i], `${path}.allOf[${i}]`);
      } catch (e: any) {
        errors.push(e.message || String(e));
      }
    }
    if (errors.length > 0) {
      throw new SchemaValidationError(
        `Value at ${path} failed allOf: ${errors.join('; ')}`,
        path,
        value
      );
    }
  }

  // not: value must NOT match the schema
  if (schema.not) {
    let matched = false;
    try {
      validateAgainstSchema(value, schema.not, `${path}.not`);
      matched = true;
    } catch {
      // value does not match the not schema — this is the expected outcome
    }
    if (matched) {
      throw new SchemaValidationError(
        `Value at ${path} must not match the schema in 'not'`,
        path,
        value
      );
    }
  }
}

function validateObject(
  value: unknown,
  schema: JsonSchema,
  path: string
): Record<string, unknown> {
  if (value === null || value === undefined) {
    throw new SchemaValidationError(
      `Expected object at ${path}, got ${value === null ? 'null' : 'undefined'}`,
      path,
      value
    );
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SchemaValidationError(
      `Expected object at ${path}, got ${typeof value}`,
      path,
      value
    );
  }

  const obj = value as Record<string, unknown>;
  const validated: Record<string, unknown> = {};

  // Check required properties
  if (schema.required) {
    for (const req of schema.required) {
      if (!(req in obj) || obj[req] === undefined) {
        throw new SchemaValidationError(
          `Missing required property '${req}' at ${path}`,
          `${path}.${req}`,
          undefined
        );
      }
    }
  }

  // Validate and collect properties
  const properties = schema.properties || {};
  const seenKeys = new Set<string>();

  for (const [key, val] of Object.entries(obj)) {
    seenKeys.add(key);
    const propSchema = properties[key];
    if (propSchema) {
      validated[key] = validateAgainstSchema(val, propSchema, `${path}.${key}`);
    } else if (schema.additionalProperties === false) {
      throw new SchemaValidationError(
        `Unexpected property '${key}' at ${path} (additionalProperties is false)`,
        `${path}.${key}`,
        val
      );
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      validated[key] = validateAgainstSchema(
        val,
        schema.additionalProperties as JsonSchema,
        `${path}.${key}`
      );
    } else {
      validated[key] = val;
    }
  }

  // Apply defaults for missing properties
  for (const [key, propSchema] of Object.entries(properties)) {
    if (!seenKeys.has(key) && propSchema.default !== undefined) {
      validated[key] = propSchema.default;
    }
  }

  return validated;
}

function validateArray(
  value: unknown,
  schema: JsonSchema,
  path: string
): unknown[] {
  if (!Array.isArray(value)) {
    throw new SchemaValidationError(
      `Expected array at ${path}, got ${typeof value}`,
      path,
      value
    );
  }

  if (schema.minItems !== undefined && value.length < schema.minItems) {
    throw new SchemaValidationError(
      `Array at ${path} has ${value.length} items, minimum is ${schema.minItems}`,
      path,
      value
    );
  }

  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    throw new SchemaValidationError(
      `Array at ${path} has ${value.length} items, maximum is ${schema.maxItems}`,
      path,
      value
    );
  }

  if (schema.items) {
    return value.map((item, i) =>
      validateAgainstSchema(item, schema.items!, `${path}[${i}]`)
    );
  }

  return value;
}

function validateString(
  value: unknown,
  schema: JsonSchema,
  path: string
): string {
  if (typeof value !== 'string') {
    // Strict: no coercion from numbers/booleans
    throw new SchemaValidationError(
      `Expected string at ${path}, got ${typeof value}`,
      path,
      value
    );
  }

  if (schema.minLength !== undefined && value.length < schema.minLength) {
    throw new SchemaValidationError(
      `String at ${path} is ${value.length} chars, minimum is ${schema.minLength}`,
      path,
      value
    );
  }

  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    throw new SchemaValidationError(
      `String at ${path} is ${value.length} chars, maximum is ${schema.maxLength}`,
      path,
      value
    );
  }

  if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
    throw new SchemaValidationError(
      `String at ${path} does not match pattern '${schema.pattern}'`,
      path,
      value
    );
  }

  if (schema.enum && !schema.enum.includes(value)) {
    throw new SchemaValidationError(
      `Value '${value}' at ${path} is not one of [${schema.enum.map(e => `'${e}'`).join(', ')}]`,
      path,
      value
    );
  }

  return value;
}

function validateNumber(
  value: unknown,
  schema: JsonSchema,
  path: string
): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new SchemaValidationError(
      `Expected number at ${path}, got ${typeof value}`,
      path,
      value
    );
  }

  if (schema.type === 'integer' && !Number.isInteger(value)) {
    throw new SchemaValidationError(
      `Expected integer at ${path}, got float ${value}`,
      path,
      value
    );
  }

  if (schema.minimum !== undefined && value < schema.minimum) {
    throw new SchemaValidationError(
      `Number ${value} at ${path} is below minimum ${schema.minimum}`,
      path,
      value
    );
  }

  if (schema.maximum !== undefined && value > schema.maximum) {
    throw new SchemaValidationError(
      `Number ${value} at ${path} is above maximum ${schema.maximum}`,
      path,
      value
    );
  }

  if (schema.enum && !schema.enum.includes(value)) {
    throw new SchemaValidationError(
      `Value ${value} at ${path} is not one of [${schema.enum.join(', ')}]`,
      path,
      value
    );
  }

  return value;
}

function validateBoolean(
  value: unknown,
  schema: JsonSchema,
  path: string
): boolean {
  if (typeof value !== 'boolean') {
    throw new SchemaValidationError(
      `Expected boolean at ${path}, got ${typeof value}`,
      path,
      value
    );
  }
  return value;
}
