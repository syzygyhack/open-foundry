/**
 * Add the columns of properties declared after their table was created.
 *
 * Object and link tables are created with CREATE TABLE IF NOT EXISTS, so a
 * later schema version that adds a property to an existing type created no
 * column for it: writes to the new property failed ("column does not exist").
 * The migration DDL cannot simply grow ALTER statements, because its text is
 * checksummed per version and every applied version would then fail its
 * checksum. This runs beside it, like the platform (consent) DDL: on every
 * applySchema, it adds whichever declared columns are missing.
 *
 * Only missing columns are altered, so a start-up with nothing to add takes no
 * table locks. An added column is nullable, with the property's default if it
 * declares one (Postgres fills existing rows with it), and NOT NULL only then:
 * a required property without a default cannot be NOT NULL on a table that
 * already has rows. Existing rows read the new property back as null (or the
 * default), as on the memory provider.
 */

import type { OntologySchema, PropertyDefinition } from '@openfoundry/spi';
import type { Queryable } from '../transactions/index.js';
import { pgIdent, pgIdentName, pgType, snakeCase } from './type-mapping.js';

function literal(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}

function addColumn(schema: string, table: string, prop: PropertyDefinition, withDefault: boolean): string {
  const hasDefault = withDefault && prop.defaultValue !== undefined && prop.defaultValue !== null;
  const def = hasDefault ? ` DEFAULT ${literal(prop.defaultValue)}` : '';
  const notNull = hasDefault && prop.required ? ' NOT NULL' : '';
  return (
    `ALTER TABLE ${pgIdent(schema)}."${table.replace(/"/g, '""')}" ` +
    `ADD COLUMN IF NOT EXISTS ${pgIdent(snakeCase(prop.name))} ${pgType(prop.type)}${def}${notNull}`
  );
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
 * The ALTER statements that would add the missing columns, without running
 * them (read-only: lets applySchema skip its lock when nothing is missing).
 */
export async function planColumns(
  q: Queryable,
  ontology: OntologySchema,
  dataSchema: string,
): Promise<string[]> {
  const existing = await q.query<{ t: string; c: string }>(
    `SELECT c.relname AS t, a.attname AS c
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = to_regnamespace($1) AND c.relkind IN ('r', 'p')
        AND a.attnum > 0 AND NOT a.attisdropped`,
    [pgIdent(dataSchema)],
  );
  const columns = new Map<string, Set<string>>();
  for (const { t, c } of existing.rows) {
    if (!columns.has(t)) columns.set(t, new Set());
    columns.get(t)!.add(c);
  }

  const wanted: Array<{ table: string; prop: PropertyDefinition; withDefault: boolean }> = [];
  for (const type of ontology.objectTypes) {
    // The names the DDL gives them: pgIdent over snakeCase (see pgIdentName).
    const table = pgIdentName(snakeCase(type.name));
    const history = pgIdentName(snakeCase(type.name) + '_history');
    for (const prop of type.properties) {
      // Object tables carry defaults; their history tables mirror the columns.
      wanted.push({ table, prop, withDefault: true });
      wanted.push({ table: history, prop, withDefault: false });
    }
  }
  for (const type of ontology.linkTypes) {
    // Link tables are created without defaults; keep added columns the same.
    const table = pgIdentName(snakeCase(type.name));
    for (const prop of type.properties ?? []) wanted.push({ table, prop, withDefault: false });
  }

  const plan: string[] = [];
  for (const { table, prop, withDefault } of wanted) {
    const have = columns.get(pgStoredName(table));
    const column = pgStoredName(pgIdentName(snakeCase(prop.name)));
    // A table that does not exist is the migration's to create, not ours.
    if (!have || have.has(column)) continue;
    plan.push(addColumn(dataSchema, table, prop, withDefault));
    have.add(column);
  }
  return plan;
}

/**
 * Add the missing columns. Returns the statements it ran.
 *
 * Run it on a client inside a transaction (applySchema does, under its
 * advisory lock): an object table and its history table must gain a column
 * together, or a write between the two ALTERs commits its row and then fails
 * its history insert (it inserts RETURNING *, which has the new column). And
 * run it before the version's own DDL, whose indexes may name the new columns.
 */
export async function reconcileColumns(
  q: Queryable,
  ontology: OntologySchema,
  dataSchema: string,
): Promise<string[]> {
  const plan = await planColumns(q, ontology, dataSchema);
  for (const stmt of plan) await q.query(stmt);
  return plan;
}
