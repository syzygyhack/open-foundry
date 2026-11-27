/**
 * Unit tests for filter expression → SQL translation.
 * No PostgreSQL required.
 */
import { describe, it, expect } from 'vitest';
import { filterToSql } from '../objects/filter-to-sql.js';
import type { FilterExpression } from '@openfoundry/spi';

describe('filterToSql', () => {
  // -------------------------------------------------------------------
  // Field predicates
  // -------------------------------------------------------------------

  describe('field predicates', () => {
    it('eq', () => {
      const result = filterToSql({ field: 'name', operator: 'eq', value: 'Alice' });
      expect(result.text).toBe('"name" = $1');
      expect(result.params).toEqual(['Alice']);
    });

    it('neq', () => {
      const result = filterToSql({ field: 'status', operator: 'neq', value: 'inactive' });
      // NULL is distinct from 'inactive', so an unset status matches.
      expect(result.text).toBe('"status" IS DISTINCT FROM $1');
      expect(result.params).toEqual(['inactive']);
    });

    it('eq null', () => {
      const result = filterToSql({ field: 'status', operator: 'eq', value: null });
      expect(result.text).toBe('"status" IS NULL');
      expect(result.params).toEqual([]);
    });

    it('gt', () => {
      const result = filterToSql({ field: 'age', operator: 'gt', value: 18 });
      expect(result.text).toBe('"age" > $1');
      expect(result.params).toEqual([18]);
    });

    it('gte', () => {
      const result = filterToSql({ field: 'age', operator: 'gte', value: 18 });
      expect(result.text).toBe('"age" >= $1');
      expect(result.params).toEqual([18]);
    });

    it('lt', () => {
      const result = filterToSql({ field: 'score', operator: 'lt', value: 50 });
      expect(result.text).toBe('"score" < $1');
      expect(result.params).toEqual([50]);
    });

    it('lte', () => {
      const result = filterToSql({ field: 'score', operator: 'lte', value: 50 });
      expect(result.text).toBe('"score" <= $1');
      expect(result.params).toEqual([50]);
    });

    it('in with values', () => {
      const result = filterToSql({ field: 'status', operator: 'in', value: ['active', 'pending'] });
      expect(result.text).toBe('"status" IN ($1, $2)');
      expect(result.params).toEqual(['active', 'pending']);
    });

    it('in with empty array returns FALSE', () => {
      const result = filterToSql({ field: 'status', operator: 'in', value: [] });
      expect(result.text).toBe('FALSE');
      expect(result.params).toEqual([]);
    });

    it('contains', () => {
      const result = filterToSql({ field: 'description', operator: 'contains', value: 'urgent' });
      // ESCAPE clause ensures wildcards in values are literal
      expect(result.text).toContain('LIKE $1 ESCAPE');
      expect(result.params).toEqual(['%urgent%']);
    });

    it('contains escapes LIKE wildcards in values', () => {
      const result = filterToSql({ field: 'description', operator: 'contains', value: '100%' });
      expect(result.params).toEqual(['%100\\%%']);
    });

    it('startsWith', () => {
      const result = filterToSql({ field: 'nhsNumber', operator: 'startsWith', value: '123' });
      expect(result.text).toContain('LIKE $1 ESCAPE');
      expect(result.params).toEqual(['123%']);
    });

    it('startsWith escapes LIKE wildcards in values', () => {
      const result = filterToSql({ field: 'nhsNumber', operator: 'startsWith', value: 'a_b' });
      expect(result.params).toEqual(['a\\_b%']);
    });

    it('exists true', () => {
      const result = filterToSql({ field: 'email', operator: 'exists', value: true });
      expect(result.text).toBe('"email" IS NOT NULL');
      expect(result.params).toEqual([]);
    });

    it('exists false', () => {
      const result = filterToSql({ field: 'email', operator: 'exists', value: false });
      expect(result.text).toBe('"email" IS NULL');
      expect(result.params).toEqual([]);
    });
  });

  // -------------------------------------------------------------------
  // Logical predicates
  // -------------------------------------------------------------------

  describe('logical predicates', () => {
    it('AND composition', () => {
      const filter: FilterExpression = {
        and: [
          { field: 'active', operator: 'eq', value: true },
          { field: 'age', operator: 'gte', value: 18 },
        ],
      };
      const result = filterToSql(filter);
      expect(result.text).toBe('("active" = $1 AND "age" >= $2)');
      expect(result.params).toEqual([true, 18]);
    });

    it('OR composition', () => {
      const filter: FilterExpression = {
        or: [
          { field: 'status', operator: 'eq', value: 'active' },
          { field: 'status', operator: 'eq', value: 'pending' },
        ],
      };
      const result = filterToSql(filter);
      expect(result.text).toBe('("status" = $1 OR "status" = $2)');
      expect(result.params).toEqual(['active', 'pending']);
    });

    it('NOT composition', () => {
      const filter: FilterExpression = {
        not: { field: 'deleted', operator: 'eq', value: true },
      };
      const result = filterToSql(filter);
      // Unknown counts as false before negation.
      expect(result.text).toBe('NOT COALESCE(("deleted" = $1), FALSE)');
      expect(result.params).toEqual([true]);
    });

    it('nested AND/OR', () => {
      const filter: FilterExpression = {
        and: [
          { field: 'active', operator: 'eq', value: true },
          {
            or: [
              { field: 'role', operator: 'eq', value: 'admin' },
              { field: 'role', operator: 'eq', value: 'editor' },
            ],
          },
        ],
      };
      const result = filterToSql(filter);
      expect(result.text).toBe('("active" = $1 AND ("role" = $2 OR "role" = $3))');
      expect(result.params).toEqual([true, 'admin', 'editor']);
    });
  });

  // -------------------------------------------------------------------
  // Parameter offset
  // -------------------------------------------------------------------

  describe('parameter offset', () => {
    it('uses custom start offset', () => {
      const result = filterToSql({ field: 'name', operator: 'eq', value: 'Bob' }, 5);
      expect(result.text).toBe('"name" = $5');
      expect(result.params).toEqual(['Bob']);
    });

    it('IN with offset', () => {
      const result = filterToSql({ field: 'status', operator: 'in', value: ['a', 'b', 'c'] }, 3);
      expect(result.text).toBe('"status" IN ($3, $4, $5)');
      expect(result.params).toEqual(['a', 'b', 'c']);
    });
  });

  // -------------------------------------------------------------------
  // camelCase to snake_case column mapping
  // -------------------------------------------------------------------

  describe('column name mapping', () => {
    it('converts camelCase fields to snake_case', () => {
      const result = filterToSql({ field: 'familyName', operator: 'eq', value: 'Smith' });
      expect(result.text).toBe('"family_name" = $1');
    });

    it('converts PascalCase fields to snake_case', () => {
      const result = filterToSql({ field: 'NHSNumber', operator: 'eq', value: '123' });
      // NHSNumber -> _n_h_s_number -> n_h_s_number (pgIdent quotes it)
      expect(result.text).toMatch(/= \$1$/);
      expect(result.params).toEqual(['123']);
    });

    it('preserves leading underscore for system fields', () => {
      const result = filterToSql({ field: '_id', operator: 'in', value: ['a', 'b'] });
      expect(result.text).toBe('"_id" IN ($1, $2)');
      expect(result.params).toEqual(['a', 'b']);
    });

    it('preserves other system field prefixes', () => {
      const result = filterToSql({ field: '_tenant_id', operator: 'eq', value: 't-1' });
      expect(result.text).toBe('"_tenant_id" = $1');
      expect(result.params).toEqual(['t-1']);
    });
  });
});
