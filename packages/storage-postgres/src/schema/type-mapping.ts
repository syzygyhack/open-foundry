/**
 * Maps ODL/SPI property types to PostgreSQL column types.
 */

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
