/**
 * ─────────────────────────────────────────────────────────────────────────────
 * UNIVERSAL ITEM ENGINE — minimal JSON Schema validator.
 *
 * The engine stores type-specific rules as structured JSON Schemas (see
 * registry.ts). This module enforces a PRACTICAL SUBSET of JSON Schema keywords
 * — enough to validate every registered item type without a heavy dependency:
 *
 *   type, properties, required, additionalProperties, items,
 *   enum, const, minimum, maximum, minLength, maxLength, pattern, anyOf
 *
 * Because validation is schema-driven, adding a brand-new business type means
 * adding ONE schema object — the validator + engine need no changes (the
 * "hyper-extensible, no schema rewrite" property).
 *
 * DESIGN — zero runtime imports (the JsonSchema import is type-only and erased)
 * so the `node --test` runner loads it directly.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { type JsonSchema } from './types.ts';

export interface SchemaValidationResult {
  ok: boolean;
  /** Human-readable, JSON-path-prefixed errors (e.g. `$.priceCents: expected integer`). */
  errors: string[];
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Simple order-insensitive deep equality for `enum` / `const` matching. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao);
    const bKeys = Object.keys(bo);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}

function matchesType(expected: NonNullable<JsonSchema['type']>, value: unknown): boolean {
  switch (expected) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function validateSchema(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  // anyOf — accept if ANY branch validates.
  if (schema.anyOf && Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    for (const branch of schema.anyOf) {
      const branchErrors: string[] = [];
      validateSchema(branch, value, path, branchErrors);
      if (branchErrors.length === 0) return;
    }
    errors.push(`${path}: does not match any allowed shape`);
    return;
  }

  if (schema.const !== undefined) {
    if (!deepEqual(schema.const, value)) {
      errors.push(`${path}: expected a fixed value`);
      return;
    }
  }

  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.some((allowed) => deepEqual(allowed, value))) {
      errors.push(`${path}: not one of the allowed values`);
      return;
    }
  }

  if (schema.type && !matchesType(schema.type, value)) {
    errors.push(`${path}: expected ${schema.type} but got ${typeOf(value)}`);
    return;
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push(`${path}: does not match pattern ${schema.pattern}`);
        }
      } catch {
        // invalid pattern in a schema is a schema bug, not a value bug
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path}: above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.items) {
      value.forEach((item, i) => validateSchema(schema.items as JsonSchema, item, `${path}[${i}]`, errors));
    }
    return;
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (schema.required && Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }
    const properties = schema.properties || {};
    for (const [key, child] of Object.entries(obj)) {
      const childSchema = properties[key];
      if (childSchema) {
        validateSchema(childSchema, child, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateSchema(schema.additionalProperties, child, `${path}.${key}`, errors);
      }
    }
  }
}

/** Validate `value` against `schema`. Returns `{ ok, errors }`. */
export function validateJsonSchema(schema: JsonSchema, value: unknown): SchemaValidationResult {
  const errors: string[] = [];
  validateSchema(schema, value, '$', errors);
  return { ok: errors.length === 0, errors };
}
