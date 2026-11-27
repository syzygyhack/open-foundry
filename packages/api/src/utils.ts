/**
 * Shared utility functions for the API package.
 */

import type { OntologyLink, RequestContext } from '@openfoundry/spi';
import type { LinkManager } from '@openfoundry/engine';

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
