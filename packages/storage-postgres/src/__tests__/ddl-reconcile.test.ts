/**
 * Unit tests for column reconciliation planning (no database).
 */

import { describe, it, expect } from 'vitest';
import type { OntologySchema } from '@openfoundry/spi';
import { planColumns, pgStoredName } from '../schema/ddl-reconcile.js';
import type { Queryable } from '../transactions/index.js';
import { snakeCase } from '../schema/type-mapping.js';
import { generateObjectTableDDL } from '../schema/ddl-objects.js';

function catalog(rows: Array<{ t: string; c: string }>): Queryable {
  return { query: async () => ({ rows }) } as unknown as Queryable;
}

describe('pgStoredName', () => {
  it('keeps names up to 63 bytes and cuts longer ones at a character boundary', () => {
    expect(pgStoredName('a'.repeat(63))).toBe('a'.repeat(63));
    expect(pgStoredName('a'.repeat(70))).toBe('a'.repeat(63));
    // 62 ASCII bytes then a 2-byte character: cutting at 63 would split it.
    expect(pgStoredName('a'.repeat(62) + 'é' + 'b')).toBe('a'.repeat(62));
  });
});

describe('planColumns', () => {
  it('matches tables by the name the DDL gives them (a leading underscore is dropped)', async () => {
    const ontology = {
      version: 2,
      objectTypes: [{ name: '_Ward', properties: [{ name: 'name', type: 'String' }, { name: 'colour', type: 'String' }] }],
      linkTypes: [],
    } as unknown as OntologySchema;
    // What generateObjectTableDDL creates for _Ward.
    const ddl = generateObjectTableDDL(ontology.objectTypes[0]!, 'public').join('\n');
    expect(ddl).toContain('"public"."ward" (');
    expect(ddl).toContain('"public"."ward_history" (');
    const q = catalog([
      { t: 'ward', c: '_id' },
      { t: 'ward', c: 'name' },
      { t: 'ward_history', c: '_id' },
      { t: 'ward_history', c: 'name' },
    ]);

    const plan = await planColumns(q, ontology, 'public');

    expect(plan).toEqual([
      expect.stringContaining('"public"."ward" ADD COLUMN IF NOT EXISTS "colour"'),
      expect.stringContaining('"public"."ward_history" ADD COLUMN IF NOT EXISTS "colour"'),
    ]);
  });

  it('matches a history table whose stored name PostgreSQL truncated', async () => {
    // snake_case of the type is 59 bytes, so "<table>_history" is 67 and is
    // stored as its first 63.
    const typeName = 'Ward' + 'x'.repeat(55);
    const table = snakeCase(typeName);
    expect(Buffer.byteLength(table)).toBe(59);
    const ontology = {
      version: 2,
      objectTypes: [{ name: typeName, properties: [{ name: 'name', type: 'String' }, { name: 'colour', type: 'String' }] }],
      linkTypes: [],
    } as unknown as OntologySchema;
    const stored = pgStoredName(`${table}_history`);
    const q = catalog([
      { t: table, c: '_id' },
      { t: table, c: 'name' },
      { t: stored, c: '_id' },
      { t: stored, c: 'name' },
    ]);

    const plan = await planColumns(q, ontology, 'public');

    expect(plan).toHaveLength(2);
    expect(plan.filter((s) => s.includes('_history'))).toHaveLength(1);
    expect(plan.every((s) => s.includes('"colour"'))).toBe(true);
  });
});
