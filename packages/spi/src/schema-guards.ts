/**
 * Schema guards shared by storage providers, so every provider answers an
 * unknown type or filter field the same way.
 *
 * - An unknown object or link type is a TYPE_NOT_FOUND error (category
 *   not_found). A missing row of a known type is not an error: reads return
 *   null or an empty page as before.
 * - A filter naming a field the type does not declare is an INVALID_FILTER
 *   error (category validation). It is checked before any row is read, so
 *   the answer does not depend on whether the type has rows. Without this, a
 *   typo returned an empty page on the memory provider, and on Postgres a
 *   pg "column does not exist" error that the API reported as a retryable 500.
 *
 * Guards apply only once a schema has been applied: a provider used without
 * one (some unit tests do) keeps accepting any type.
 */

import type { FilterExpression, OntologySchema } from './ontology.js';
import type { ErrorCode } from './errors.js';

/** An Error carrying a platform error code, as the API's error mapping reads it. */
export class SchemaGuardError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'SchemaGuardError';
    this.code = code;
  }
}

/**
 * System fields a filter may name on any object or link, in either spelling
 * (the platform uses `_deleted_at` and `_id` in its own filters). Each maps to
 * the record's camelCase key.
 */
export const SYSTEM_FILTER_FIELDS: Readonly<Record<string, string>> = {
  _id: '_id',
  _type: '_type',
  _version: '_version',
  _tenantId: '_tenantId',
  _tenant_id: '_tenantId',
  _createdAt: '_createdAt',
  _created_at: '_createdAt',
  _updatedAt: '_updatedAt',
  _updated_at: '_updatedAt',
  _deletedAt: '_deletedAt',
  _deleted_at: '_deletedAt',
};

const LINK_SYSTEM_FILTER_FIELDS: Readonly<Record<string, string>> = {
  ...SYSTEM_FILTER_FIELDS,
  _fromType: '_fromType',
  _from_type: '_fromType',
  _fromId: '_fromId',
  _from_id: '_fromId',
  _toType: '_toType',
  _to_type: '_toType',
  _toId: '_toId',
  _to_id: '_toId',
};

/**
 * The record key a filter field reads: a system field's camelCase key, or the
 * field itself. Own keys only, so an inherited name is not a system field.
 */
export function systemFilterKey(field: string): string {
  return Object.hasOwn(SYSTEM_FILTER_FIELDS, field) ? SYSTEM_FILTER_FIELDS[field]! : field;
}

function hasSchema(schema: OntologySchema | undefined): schema is OntologySchema {
  return schema !== undefined;
}

/** Throws TYPE_NOT_FOUND unless the schema declares the object type. */
export function assertObjectType(schema: OntologySchema | undefined, type: string): void {
  if (!hasSchema(schema)) return;
  if (!schema.objectTypes.some((t) => t.name === type)) {
    throw new SchemaGuardError('TYPE_NOT_FOUND', `Object type ${type} is not declared in the schema`);
  }
}

/** Throws TYPE_NOT_FOUND unless the schema declares the link type. */
export function assertLinkType(schema: OntologySchema | undefined, type: string): void {
  if (!hasSchema(schema)) return;
  if (!schema.linkTypes.some((t) => t.name === type)) {
    throw new SchemaGuardError('TYPE_NOT_FOUND', `Link type ${type} is not declared in the schema`);
  }
}

/** Field names a filter references, recursively. */
export function filterFields(filter: FilterExpression | undefined): string[] {
  if (!filter) return [];
  const f = filter as unknown as Record<string, unknown>;
  if ('field' in f && 'operator' in f) return [f['field'] as string];
  const out: string[] = [];
  for (const key of ['and', 'or'] as const) {
    const list = f[key];
    if (Array.isArray(list)) for (const sub of list) out.push(...filterFields(sub as FilterExpression));
  }
  if (f['not']) out.push(...filterFields(f['not'] as FilterExpression));
  return out;
}

/**
 * Throws INVALID_FILTER if the filter names a field that is neither a declared
 * property of the type nor a system field. Assumes the type itself is known.
 */
export function assertFilterFields(
  schema: OntologySchema | undefined,
  kind: 'object' | 'link',
  type: string,
  filter: FilterExpression | undefined,
): void {
  if (!hasSchema(schema) || !filter) return;
  const def =
    kind === 'object'
      ? schema.objectTypes.find((t) => t.name === type)
      : schema.linkTypes.find((t) => t.name === type);
  if (!def) return;
  const declared = new Set((def.properties ?? []).map((p) => p.name));
  const system = kind === 'object' ? SYSTEM_FILTER_FIELDS : LINK_SYSTEM_FILTER_FIELDS;
  // Own keys only: `in` would accept inherited names such as constructor,
  // toString or __proto__.
  const unknown = [...new Set(filterFields(filter))].filter((f) => !declared.has(f) && !Object.hasOwn(system, f));
  if (unknown.length > 0) {
    throw new SchemaGuardError(
      'INVALID_FILTER',
      `Filter on ${type} names undeclared field(s): ${unknown.join(', ')}`,
    );
  }
}
