/**
 * Shared utility functions for the API package.
 */

import type { FilterExpression, OntologyLink, RequestContext } from '@openfoundry/spi';
import { SYSTEM_FILTER_FIELDS } from '@openfoundry/spi';
import type { LinkManager } from '@openfoundry/engine';
import type { FieldDefinition } from '@openfoundry/odl';

/** Convert first character to lowercase. */
export function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Convert PascalCase to snake_case — must match FGA codegen convention. */
export function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Every link of one type from or to an object, across all pages.
 *
 * History reads (includeDeleted) return links oldest first, so a single page
 * fills with past records and can leave out the current one. The FHIR and CDM
 * Encounter projections use this to see a patient's whole admission history.
 *
 * Paging follows hasNextPage alone. totalCount is not used to stop, and a page
 * that repeats earlier links does not stop it either: offset pages can shift
 * when links are written between reads, so a repeated page can come before
 * the page that holds the current link. Links are de-duplicated by ID. A walk
 * past maxPages throws rather than truncating silently or looping forever on
 * a provider that never reports the last page.
 */
export async function getAllLinks(
  linkManager: Pick<LinkManager, 'getLinks'>,
  objectId: string,
  linkType: string,
  direction: 'outbound' | 'inbound',
  options: { includeDeleted?: boolean; pageSize?: number; maxPages?: number },
  ctx: RequestContext,
): Promise<OntologyLink[]> {
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 1000;
  const byId = new Map<string, OntologyLink>();
  for (let page = 0; ; page++) {
    if (page === maxPages) {
      throw new Error(
        `getAllLinks: ${linkType} links of ${objectId} still report a next page after ${maxPages} pages`,
      );
    }
    const result = await linkManager.getLinks(
      objectId,
      linkType,
      direction,
      { limit: pageSize, offset: page * pageSize, includeDeleted: options.includeDeleted },
      ctx,
    );
    for (const link of result.items) if (!byId.has(link._id)) byId.set(link._id, link);
    if (!result.hasNextPage || result.items.length === 0) break;
  }
  return [...byId.values()];
}

/**
 * Rename the type's primary field (e.g. `id`) to `_id` in a filter. Storage
 * keeps the primary key in the `_id` system field, not as a property (the
 * schema loader strips it from the stored properties), so a REST
 * `filter[id]=x` or GraphQL `filter: {id: {eq: x}}` must reach it under that
 * name. Used by both.
 */
export function mapPrimaryField(filter: FilterExpression, primary: string | undefined): FilterExpression {
  if (!primary) return filter;
  const f = filter as unknown as Record<string, unknown>;
  if ('field' in f) return f['field'] === primary ? ({ ...f, field: '_id' } as unknown as FilterExpression) : filter;
  const out: Record<string, unknown> = { ...f };
  for (const key of ['and', 'or'] as const) {
    if (Array.isArray(f[key])) out[key] = (f[key] as FilterExpression[]).map((sub) => mapPrimaryField(sub, primary));
  }
  if (f['not']) out['not'] = mapPrimaryField(f['not'] as FilterExpression, primary);
  return out as unknown as FilterExpression;
}

/** The same renaming for sort keys. */
export function mapPrimarySort<T extends { field: string }>(orderBy: T[] | undefined, primary: string | undefined): T[] | undefined {
  if (!orderBy || !primary) return orderBy;
  return orderBy.map((o) => (o.field === primary ? { ...o, field: '_id' } : o));
}

/**
 * The names in an aggregate's orderBy that are source fields, for the
 * field-restriction check. A name that is one of the aggregate's own outputs
 * (its alias, or `<fn>_<field>` when it has none) sorts by that output, whose
 * inputs are checked already, and is left out. A name that is both an output
 * and a declared field of the type stays in: which one storage sorts by is
 * not something to bet a restricted field on.
 */
export function aggregateSortSourceFields(
  orderBy: { field: string }[] | undefined,
  fields: { field: string; fn: string; alias?: string }[],
  declared: Iterable<string>,
): string[] {
  if (!orderBy) return [];
  const outputs = new Set(fields.map((f) => f.alias ?? `${f.fn}_${f.field}`));
  const typeFields = new Set(declared);
  return orderBy.map((o) => o.field).filter((name) => !outputs.has(name) || typeFields.has(name));
}

/**
 * The names among `names` that a caller with field restrictions may not
 * filter or sort on. Only the platform's own system fields (SYSTEM_FILTER_FIELDS:
 * _createdAt, _deleted_at, ...) are exempt, not every name with a leading
 * underscore: a type may declare `_recordId` as a field. `_id` is the type's
 * primary key under its storage name, so it is checked as the primary field.
 */
export function restrictedFieldNames(
  names: Iterable<string>,
  visible: Set<string>,
  primary: string | undefined,
): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const field = name === '_id' ? primary : name;
    if (field === undefined) continue; // _id of a type with no primary field
    if (field !== primary && Object.hasOwn(SYSTEM_FILTER_FIELDS, field)) continue;
    if (!visible.has(field)) out.add(field);
  }
  return [...out];
}

/**
 * The fields a search may look in when the caller has field restrictions and
 * names none: the type's visible text properties. Not the primary field (it
 * is stored as _id, not as a column), not system fields, and not properties
 * named with a leading underscore (storage resolves such a name as a system
 * column, `"_display_label"`, where the DDL made `"display_label"`). Possibly
 * empty: storage then searches no field and finds nothing.
 */
export function visibleSearchFields(visible: Set<string>, fields: FieldDefinition[]): string[] {
  return fields
    .filter((f) => visible.has(f.name))
    .filter((f) => f.type.name === 'String' && !f.type.isList)
    // Stored properties only, as the schema loader stores them: not the
    // primary field (kept as _id), nor @computed or @link fields (no column).
    .filter((f) => !f.directives.some((d) => d.kind === 'primary' || d.kind === 'computed' || d.kind === 'link'))
    .filter((f) => !f.name.startsWith('_'))
    .map((f) => f.name);
}

/**
 * The named search fields a caller with field restrictions may not search:
 * every name outside its visible set, system fields included (a search runs
 * a text match on each named column), with `_id` checked as the primary field.
 */
export function restrictedSearchFieldNames(
  names: Iterable<string>,
  visible: Set<string>,
  primary: string | undefined,
): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const field = name === '_id' && primary !== undefined ? primary : name;
    if (!visible.has(field)) out.add(field);
  }
  return [...out];
}
