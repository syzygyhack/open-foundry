/**
 * Maps ODL/SPI property types to PostgreSQL column types.
 */

import type { OntologySchema } from '@openfoundry/spi';
import { SchemaGuardError } from '@openfoundry/spi';

const ODL_TO_PG: Record<string, string> = {
  // Scalars
  String: 'TEXT',
  Int: 'INTEGER',
  Float: 'DOUBLE PRECISION',
  Boolean: 'BOOLEAN',
  ID: 'TEXT',

  // Date/time
  DateTime: 'TIMESTAMPTZ',
  Date: 'DATE',
  Time: 'TIME',
  Duration: 'INTERVAL',

  // JSON / untyped
  JSON: 'JSONB',

  // NHS-specific scalars mapped to TEXT (stored as validated strings)
  NHSNumber: 'TEXT',
  ODS: 'TEXT',
  SNOMED: 'TEXT',
  Email: 'TEXT',
  Phone: 'TEXT',
  URL: 'TEXT',
  Markdown: 'TEXT',
};

/**
 * Convert an ODL/SPI property type name to a PostgreSQL column type.
 * Unknown types default to TEXT (enum types, custom scalars).
 */
export function pgType(odlType: string): string {
  return ODL_TO_PG[odlType] ?? 'TEXT';
}

/**
 * Convert an SPI IndexType to PostgreSQL index method.
 */
export function pgIndexMethod(indexType: string): string {
  switch (indexType) {
    case 'BTREE':
      return 'btree';
    case 'HASH':
      return 'hash';
    case 'GIN':
      return 'gin';
    case 'GIST':
      return 'gist';
    case 'FULLTEXT':
      return 'gin'; // GIN with tsvector for full-text search
    default:
      return 'btree';
  }
}

/**
 * Sanitize an identifier for PostgreSQL (lowercase snake_case, quoted if needed).
 */
export function pgIdent(name: string): string {
  const snake = pgIdentName(name);
  // Escape embedded double-quotes per SQL standard (double them),
  // then wrap in double-quotes to avoid reserved word conflicts.
  const escaped = snake.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * The name pgIdent quotes, before PostgreSQL's 63-byte limit: PascalCase /
 * camelCase to snake_case, one leading underscore dropped. DDL applies it on
 * top of snakeCase (pgIdent(snakeCase(type.name))), so code that matches
 * catalog names must do the same: `_Ward` is table "ward", not "_ward".
 */
export function pgIdentName(name: string): string {
  return name
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

const NAME_MAX_BYTES = 63; // NAMEDATALEN - 1

/**
 * The name PostgreSQL stores for an identifier: cut to 63 bytes, at a
 * character boundary. A history table of a type whose name is near the limit
 * ("<table>_history") is stored truncated, and must be matched that way.
 */
export function pgStoredName(name: string): string {
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length <= NAME_MAX_BYTES) return name;
  let end = NAME_MAX_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
/**
 * The name PostgreSQL stores for an identifier the DDL writes as
 * pgIdent(name): pgIdentName, then cut to 63 bytes. Code that looks a table,
 * column or schema up in the catalog by name must use this, not snakeCase:
 * `_Ward` is stored as "ward", and a long name is stored truncated.
 */
export function physicalName(name: string): string {
  return pgStoredName(pgIdentName(name));
}

/**
 * Throws VALIDATION_ERROR if two of the schema's tables would get the same
 * stored name: two types that differ only in what pgIdentName drops (`Ward`
 * and `_Ward`), or a type name long enough that PostgreSQL's 63-byte cut
 * makes its table and its history table one table (every write then failed
 * on a duplicate key in the history insert).
 */
export function assertDistinctPhysicalNames(schema: OntologySchema): void {
  const owners = new Map<string, string>();
  const claim = (table: string, owner: string): void => {
    const stored = physicalName(table);
    const other = owners.get(stored);
    if (other !== undefined) {
      throw new SchemaGuardError(
        'VALIDATION_ERROR',
        `${owner} and ${other} would both be stored as table "${stored}" ` +
          '(PostgreSQL drops a leading underscore here and cuts names to 63 bytes); rename one',
      );
    }
    owners.set(stored, owner);
  };
  for (const t of schema.objectTypes) {
    claim(snakeCase(t.name), `object type ${t.name}`);
    claim(snakeCase(t.name) + '_history', `the history of object type ${t.name}`);
  }
  for (const t of schema.linkTypes) claim(snakeCase(t.name), `link type ${t.name}`);
}

/**
 * Create an unquoted snake_case version for use in index/constraint names.
 */
export function snakeCase(name: string): string {
  return name
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

/**
 * Return the unquoted PostgreSQL column name for a field.
 * System fields (prefixed with _) convert the body from camelCase to snake_case
 * while preserving the leading underscore:
 *   _createdAt → _created_at, _tenantId → _tenant_id, _id → _id
 * User fields go through standard snakeCase conversion.
 */
export function fieldColName(field: string): string {
  if (field.startsWith('_')) {
    const body = field.slice(1);
    return `_${body.replace(/([A-Z])/g, '_$1').toLowerCase()}`;
  }
  return snakeCase(field);
}

/**
 * Quote a field name as a PostgreSQL column identifier.
 * Uses fieldColName for the mapping, then wraps in double-quotes.
 */
export function fieldCol(field: string): string {
  const col = fieldColName(field);
  const escaped = col.replace(/"/g, '""');
  return `"${escaped}"`;
}
