/**
 * Translates FilterExpression trees into parameterized SQL WHERE clauses.
 *
 * All user-supplied values are passed via $N bind parameters to prevent
 * SQL injection. Column names are mapped through snakeCase + pgIdent to
 * ensure safe quoting.
 */

import type { FilterExpression, FieldPredicate, LogicalPredicate } from '@openfoundry/spi';
import { fieldCol } from '../schema/type-mapping.js';

/** Result of translating a FilterExpression. */
export interface SqlFragment {
  /** SQL text with $N placeholders. */
  text: string;
  /** Bind parameter values matching the $N placeholders. */
  params: unknown[];
}

function isFieldPredicate(f: FilterExpression): f is FieldPredicate {
  return 'field' in f && 'operator' in f;
}

function isLogicalPredicate(f: FilterExpression): f is LogicalPredicate {
  return 'and' in f || 'or' in f || 'not' in f;
}

/**
 * Translate a FilterExpression into a parameterized SQL WHERE fragment.
 *
 * @param filter  The filter tree to translate.
 * @param offset  Starting index for $N placeholders (1-based).
 * @returns       SQL fragment with text and bind parameters.
 */
export function filterToSql(filter: FilterExpression, offset = 1): SqlFragment {
  if (isFieldPredicate(filter)) {
    return fieldPredicateToSql(filter, offset);
  }
  if (isLogicalPredicate(filter)) {
    return logicalPredicateToSql(filter, offset);
  }
  // Fallback: empty filter matches everything
  return { text: 'TRUE', params: [] };
}

function fieldPredicateToSql(pred: FieldPredicate, offset: number): SqlFragment {
  const col = fieldCol(pred.field);

  switch (pred.operator) {
    // Unset and null are the same value, and a comparison with it is false,
    // except that eq null matches it and neq matches it unless the value is
    // null: the memory provider's semantics. SQL's `= NULL` is never true and
    // `!= 'x'` is unknown, not true, for a NULL column.
    case 'eq':
      if (pred.value === null) return { text: `${col} IS NULL`, params: [] };
      return { text: `${col} = $${offset}`, params: [pred.value] };
    case 'neq':
      return { text: `${col} IS DISTINCT FROM $${offset}`, params: [pred.value] };
    case 'gt':
      return { text: `${col} > $${offset}`, params: [pred.value] };
    case 'gte':
      return { text: `${col} >= $${offset}`, params: [pred.value] };
    case 'lt':
      return { text: `${col} < $${offset}`, params: [pred.value] };
    case 'lte':
      return { text: `${col} <= $${offset}`, params: [pred.value] };
    case 'in': {
      // value is expected to be an array
      const arr = pred.value as unknown[];
      if (!Array.isArray(arr) || arr.length === 0) {
        return { text: 'FALSE', params: [] };
      }
      const placeholders = arr.map((_, i) => `$${offset + i}`).join(', ');
      return { text: `${col} IN (${placeholders})`, params: [...arr] };
    }
    case 'contains': {
      // Escape LIKE wildcards so they match literally
      const escaped = String(pred.value).replace(/[%_\\]/g, '\\$&');
      return { text: `${col} LIKE $${offset} ESCAPE '\\'`, params: [`%${escaped}%`] };
    }
    case 'startsWith': {
      const escaped = String(pred.value).replace(/[%_\\]/g, '\\$&');
      return { text: `${col} LIKE $${offset} ESCAPE '\\'`, params: [`${escaped}%`] };
    }
    case 'exists':
      if (pred.value) {
        return { text: `${col} IS NOT NULL`, params: [] };
      }
      return { text: `${col} IS NULL`, params: [] };
    default:
      return { text: 'TRUE', params: [] };
  }
}

function logicalPredicateToSql(pred: LogicalPredicate, offset: number): SqlFragment {
  if (pred.and && pred.and.length > 0) {
    return composeFragments(pred.and, 'AND', offset);
  }
  if (pred.or && pred.or.length > 0) {
    return composeFragments(pred.or, 'OR', offset);
  }
  if (pred.not) {
    const inner = filterToSql(pred.not, offset);
    // Unknown (a comparison with NULL) counts as false before it is negated,
    // so not(eq 'x') matches a NULL column, as on the memory provider. Only
    // here: elsewhere unknown and false already select the same rows, and an
    // unwrapped predicate keeps its index.
    return { text: `NOT COALESCE((${inner.text}), FALSE)`, params: inner.params };
  }
  return { text: 'TRUE', params: [] };
}

function composeFragments(
  filters: FilterExpression[],
  operator: 'AND' | 'OR',
  offset: number,
): SqlFragment {
  const parts: string[] = [];
  const allParams: unknown[] = [];
  let currentOffset = offset;

  for (const f of filters) {
    const fragment = filterToSql(f, currentOffset);
    parts.push(fragment.text);
    allParams.push(...fragment.params);
    currentOffset += fragment.params.length;
  }

  const text = parts.length === 1
    ? parts[0]!
    : `(${parts.join(` ${operator} `)})`;

  return { text, params: allParams };
}
