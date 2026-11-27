/**
 * Auto-generated REST route factory (Section 8.2).
 *
 * Takes a ParsedSchema and ApiDependencies, produces REST route definitions.
 * Each ObjectType gets:
 *   GET  /api/v1/{plural}            — list with query params
 *   GET  /api/v1/{plural}/:id        — get by ID
 *   GET  /api/v1/{plural}/:id/links/:linkType — linked objects
 *   GET  /api/v1/{plural}/:id/history — version history
 *
 * Each ActionType gets:
 *   POST /api/v1/actions/{ActionName} — execute action
 *
 * All routes go through the same security pipeline (auth, authz, consent)
 * as the GraphQL layer. Error responses use the unified error model (Section 8.8).
 */

import type { ParsedSchema, ObjectType, ActionType, FieldDefinition } from '@openfoundry/odl';
import { DataPurpose } from '@openfoundry/spi';
import type { OntologyObject, FilterExpression, AggregateQuery, AggregateField, AggregateFunction, SearchQuery, ObjectSetDefinition } from '@openfoundry/spi';
import type { ActionActor, ActionContext } from '@openfoundry/actions';
import type { RedactionResult } from '@openfoundry/security';
import type { ApiDependencies, ResolverContext } from '../graphql/types.js';
import { DEFAULT_CONSENT_PURPOSE, DEFAULT_CONSENT_SUBJECT_TYPES, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../graphql/types.js';
import type { RestRequest, RestResponse, RestRoute } from './types.js';
import { createRestErrorResponse, wrapErrorToRest } from './errors.js';
import {
  aggregateSortSourceFields,
  lowerFirst,
  mapPrimaryField,
  mapPrimarySort,
  restrictedFieldNames,
  restrictedSearchFieldNames,
  toSnakeCase,
  visibleSearchFields,
} from '../utils.js';
import { paginateWithConsent } from '../consent-pagination.js';

// ─── Helpers ───

function pluralize(s: string): string {
  return lowerFirst(s) + 's';
}

function isPrimaryField(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'primary');
}

function isParamField(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'param');
}

/**
 * Recursively collect field names referenced in an SPI FilterExpression.
 * Used to enforce field-level authorization on filter predicates.
 */
function collectFilterFields(filter: FilterExpression | undefined): string[] {
  if (!filter || typeof filter !== 'object') return [];
  // Every field the node or its branches name, whatever shape it has: storage
  // reads a node with `field` but no `operator` as a logical node, so a
  // `field` here must not hide the branches beside it from the check.
  const fields: string[] = [];
  const node = filter as { field?: unknown };
  if (typeof node.field === 'string') fields.push(node.field);
  const logical = filter as { and?: FilterExpression[]; or?: FilterExpression[]; not?: FilterExpression };
  if (Array.isArray(logical.and)) {
    for (const sub of logical.and) fields.push(...collectFilterFields(sub));
  }
  if (Array.isArray(logical.or)) {
    for (const sub of logical.or) fields.push(...collectFilterFields(sub));
  }
  if (logical.not) {
    fields.push(...collectFilterFields(logical.not));
  }
  return fields;
}

/**
 * Convert an OntologyObject to a REST-friendly shape.
 * Same logic as GraphQL objectToGraphQL.
 */
function objectToRest(obj: OntologyObject, objectType: ObjectType): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of objectType.fields) {
    if (isPrimaryField(field)) {
      result[field.name] = obj[`_${field.name}`] ?? obj[field.name];
    } else {
      result[field.name] = obj[field.name];
    }
  }

  result._redactedFields = null;
  result._consentRestricted = false;

  return result;
}


/**
 * Parse REST query params into a FilterExpression.
 * Supports filter[field]=value format for simple equality filters.
 */
function parseQueryFilter(
  query: Record<string, unknown>,
): FilterExpression | undefined {
  const predicates: FilterExpression[] = [];

  const addPredicate = (fieldName: string, value: unknown): void => {
    const fieldValue = Array.isArray(value) ? value[0] : value;
    if (fieldValue == null) return;
    predicates.push({ field: fieldName, operator: 'eq', value: fieldValue as string });
  };

  // Express's default (qs) query parser turns `filter[specialty]=x` into a
  // nested object: req.query.filter = { specialty: 'x' }. Handle that form...
  const nested = query['filter'];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    for (const [fieldName, value] of Object.entries(nested as Record<string, unknown>)) {
      addPredicate(fieldName, value);
    }
  }

  // ...and the flat form `filter[specialty]` as a literal key (simple parsers).
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    const match = key.match(/^filter\[(\w+)\]$/);
    if (match && match[1]) {
      addPredicate(match[1], value);
    }
  }

  if (predicates.length === 0) return undefined;
  if (predicates.length === 1) return predicates[0];
  return { and: predicates };
}

/**
 * Parse pagination from query params.
 */
function parsePagination(query: Record<string, string | string[] | undefined>): { offset: number; limit: number } {
  const limitStr = typeof query['limit'] === 'string' ? query['limit'] : undefined;
  const offsetStr = typeof query['offset'] === 'string' ? query['offset'] : undefined;

  const limit = Math.max(0, Math.min(
    limitStr ? parseInt(limitStr, 10) || DEFAULT_PAGE_SIZE : DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  ));
  const offset = Math.max(0, offsetStr ? parseInt(offsetStr, 10) || 0 : 0);

  return { offset, limit };
}

// ─── Auth helpers ───

/**
 * Resolve authorized object IDs for a user+type via FGA listObjects.
 * Returns ['*'] when the dev stub signals all objects are authorized.
 */
async function resolveAllowedIds(
  deps: ApiDependencies,
  userId: string,
  fgaType: string,
): Promise<string[]> {
  const allowedObjects = await deps.authorizationService.listObjects(
    `user:${userId}`,
    'viewer',
    fgaType,
  );
  if (allowedObjects.length === 1 && allowedObjects[0] === '*') {
    return ['*'];
  }
  return allowedObjects.map((o: string) => {
    const parts = o.split(':');
    return parts[parts.length - 1];
  }).filter((id): id is string => id !== undefined && id !== '');
}

/**
 * Build a combined filter that restricts to authorized IDs + optional user filter.
 * When allowedIds is ['*'] (dev stub), skip the ID restriction.
 */
function buildAuthFilter(
  allowedIds: string[],
  userFilter?: FilterExpression,
): FilterExpression {
  const allAuthorized = allowedIds.length === 1 && allowedIds[0] === '*';
  if (allAuthorized) {
    const passThrough: FilterExpression = { field: '_deleted_at', operator: 'exists', value: false };
    return userFilter ? { and: [passThrough, userFilter] } : passThrough;
  }
  const idFilter: FilterExpression = {
    field: '_id',
    operator: 'in',
    value: allowedIds,
  };
  return userFilter ? { and: [idFilter, userFilter] } : idFilter;
}

// ─── Public API ───

/**
 * Generate REST route definitions from ParsedSchema and dependencies.
 */
export function generateRestRoutes(
  schema: ParsedSchema,
  deps: ApiDependencies,
): RestRoute[] {
  const routes: RestRoute[] = [];

  for (const obj of schema.objectTypes) {
    routes.push(...generateObjectRoutes(obj, deps));
  }

  for (const action of schema.actionTypes) {
    routes.push(generateActionRoute(action, schema, deps));
  }

  // Object Set routes
  routes.push(...generateObjectSetRoutes(schema, deps));

  return routes;
}

// ─── Object routes ───

function generateObjectRoutes(
  obj: ObjectType,
  deps: ApiDependencies,
): RestRoute[] {
  const plural = pluralize(obj.name);
  const fgaType = toSnakeCase(obj.name);

  // Route order matters for Express: static path segments must come before
  // parameterized segments (e.g., /search before /:id) to avoid shadowing.
  return [
    generateListRoute(obj, plural, fgaType, deps),
    generateAggregateRoute(obj, plural, fgaType, deps),
    generateSearchRoute(obj, plural, fgaType, deps),
    generateGetByIdRoute(obj, plural, fgaType, deps),
    generateLinksRoute(plural, fgaType, deps),
    generateHistoryRoute(obj, plural, fgaType, deps),
  ];
}

/**
 * GET /api/v1/{plural} — list with query params for filtering and pagination.
 */
function generateListRoute(
  obj: ObjectType,
  plural: string,
  fgaType: string,
  deps: ApiDependencies,
): RestRoute {
  return {
    method: 'GET',
    pattern: `/api/v1/${plural}`,
    handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
      try {
        const { user, requestContext } = ctx;
        const typeName = obj.name;

        // Authorization: list objects user can see.
        // Dev stub returns ['*'] sentinel meaning "all objects authorized".
        const allowedObjects = await deps.authorizationService.listObjects(
          `user:${user.id}`,
          'viewer',
          fgaType,
        );

        const allAuthorized = allowedObjects.length === 1 && allowedObjects[0] === '*';
        const allowedIds = allAuthorized ? [] : allowedObjects.map((o: string) => {
          const parts = o.split(':');
          return parts[parts.length - 1];
        }).filter((id): id is string => id !== undefined && id !== '');

        // SEC-10: If no objects are authorized, return empty result immediately
        if (!allAuthorized && allowedIds.length === 0) {
          return {
            status: 200,
            body: {
              data: [],
              pagination: { totalCount: 0, limit: parsePagination(req.query).limit, offset: 0, hasNextPage: false, hasPreviousPage: false },
            },
          };
        }

        // A field the type does not declare is rejected by storage with a
        // non-retryable 400 INVALID_FILTER (it used to surface as a retryable
        // 500 on Postgres and an empty page on the memory provider).
        const parsedFilter = parseQueryFilter(req.query);
        const userFilter = parsedFilter
          ? mapPrimaryField(parsedFilter, obj.fields.find((f) => isPrimaryField(f))?.name)
          : undefined;

        // SEC-14: Validate filter fields against redacted fields
        const visibleFields = deps.authorizationService.getVisibleFields(user.id, user.roles, typeName);
        if (visibleFields && userFilter) {
          // The names the client sent (before the primary-field mapping).
          const filterViolations = restrictedFieldNames(
            collectFilterFields(parsedFilter),
            visibleFields,
            obj.fields.find((f) => isPrimaryField(f))?.name,
          );
          if (filterViolations.length > 0) {
            return createRestErrorResponse({
              code: 'ACCESS_DENIED',
              category: 'authorization',
              message: `Cannot filter on redacted fields: ${filterViolations.join(', ')}`,
              retryable: false,
              traceId: requestContext.traceId,
            });
          }
        }

        // Build combined filter — skip ID restriction when all authorized
        let combinedFilter: FilterExpression;
        if (!allAuthorized) {
          const idFilter: FilterExpression = { field: '_id', operator: 'in', value: allowedIds };
          combinedFilter = userFilter ? { and: [idFilter, userFilter] } : idFilter;
        } else {
          const passThrough: FilterExpression = { field: '_deleted_at', operator: 'exists', value: false };
          combinedFilter = userFilter ? { and: [passThrough, userFilter] } : passThrough;
        }

        const { offset, limit } = parsePagination(req.query);

        const mapAndRedact = (objs: OntologyObject[]): Record<string, unknown>[] =>
          deps.authorizationService
            .redactFieldsBatch(
              user.id,
              user.roles,
              typeName,
              objs.map((item: OntologyObject) => objectToRest(item, obj)),
            )
            .map((r: RedactionResult<Record<string, unknown>>) => {
              const data = r.data as Record<string, unknown>;
              data._redactedFields = r._redactedFields.length > 0 ? r._redactedFields : null;
              data._consentRestricted = false;
              return data;
            });

        let items: Record<string, unknown>[];
        let totalCount: number;
        let hasNextPage: boolean;

        if (deps.consentService) {
          // Consent removes records, so it must be applied BEFORE slicing the
          // page (see consent-pagination.ts) — DB-level pagination then consent
          // drops drift totalCount/hasNextPage and can hide later pages.
          const getPrimaryId = (item: Record<string, unknown>) => {
            const primaryField = obj.fields.find(f => isPrimaryField(f));
            return String(item[primaryField?.name ?? 'id'] ?? '');
          };
          const result = await paginateWithConsent<OntologyObject, Record<string, unknown>>(
            offset,
            limit,
            async (windowLimit) => {
              const scan = await deps.objectManager.query(
                typeName, combinedFilter, { limit: windowLimit, offset: 0 }, requestContext,
              );
              return { items: scan.items, total: scan.totalCount };
            },
            async (raw) => {
              const consentResult = await deps.consentService!.filterList(
                mapAndRedact(raw), getPrimaryId, DEFAULT_CONSENT_PURPOSE as DataPurpose,
                user.id, requestContext.tenantId,
              );
              return consentResult.edges as Record<string, unknown>[];
            },
          );
          items = result.items;
          totalCount = result.totalCount;
          hasNextPage = result.hasNextPage;
        } else {
          // No consent gate — efficient DB-level pagination.
          const page = await deps.objectManager.query(
            typeName,
            combinedFilter,
            { limit, offset },
            requestContext,
          );
          items = mapAndRedact(page.items);
          totalCount = page.totalCount;
          hasNextPage = offset + items.length < totalCount;
        }

        return {
          status: 200,
          body: {
            data: items,
            pagination: {
              totalCount,
              limit,
              offset,
              hasNextPage,
              hasPreviousPage: offset > 0,
            },
          },
        };
      } catch (err) {
        return wrapErrorToRest(err, ctx.requestContext.traceId);
      }
    },
  };
}

/**
 * GET /api/v1/{plural}/:id — get single object by ID.
 */
function generateGetByIdRoute(
  obj: ObjectType,
  plural: string,
  fgaType: string,
  deps: ApiDependencies,
): RestRoute {
  return {
    method: 'GET',
    pattern: `/api/v1/${plural}/:id`,
    handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
      try {
        const { user, requestContext } = ctx;
        const typeName = obj.name;
        const id = req.params['id']!;

        // Authorize
        const allowed = await deps.authorizationService.check(
          `user:${user.id}`,
          'viewer',
          `${fgaType}:${id}`,
        );
        if (!allowed) {
          return createRestErrorResponse({
            code: 'FORBIDDEN',
            category: 'authorization',
            message: `Access denied to ${typeName} ${id}`,
            retryable: false,
            traceId: requestContext.traceId,
          });
        }

        // Get from engine
        const result = await deps.objectManager.get(typeName, id, requestContext);
        if (!result) {
          return createRestErrorResponse({
            code: 'OBJECT_NOT_FOUND',
            category: 'not_found',
            message: `${typeName} ${id} not found`,
            retryable: false,
            traceId: requestContext.traceId,
          });
        }

        let restObj = objectToRest(result, obj);

        // Field-level redaction
        const redacted = deps.authorizationService.redactFields(
          user.id,
          user.roles,
          typeName,
          restObj,
        );
        restObj = redacted.data as Record<string, unknown>;
        restObj._redactedFields = redacted._redactedFields.length > 0 ? redacted._redactedFields : null;

        // Consent filtering
        if (deps.consentService) {
          const consentResult = await deps.consentService.checkSingleObject(
            restObj,
            id,
            DEFAULT_CONSENT_PURPOSE as DataPurpose,
            user.id,
            requestContext.tenantId,
          );
          if (consentResult._consentRestricted) {
            restObj._consentRestricted = true;
            for (const field of obj.fields) {
              if (!isPrimaryField(field)) {
                restObj[field.name] = null;
              }
            }
          }
        }

        return {
          status: 200,
          body: { data: restObj },
        };
      } catch (err) {
        return wrapErrorToRest(err, ctx.requestContext.traceId);
      }
    },
  };
}

/**
 * GET /api/v1/{plural}/:id/links/:linkType — linked objects.
 */
function generateLinksRoute(
  plural: string,
  fgaType: string,
  deps: ApiDependencies,
): RestRoute {
  return {
    method: 'GET',
    pattern: `/api/v1/${plural}/:id/links/:linkType`,
    handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
      try {
        const { user, requestContext } = ctx;
        const id = req.params['id']!;
        const linkType = req.params['linkType']!;

        // Authorize — user must have view access to the parent object
        const allowed = await deps.authorizationService.check(
          `user:${user.id}`,
          'viewer',
          `${fgaType}:${id}`,
        );
        if (!allowed) {
          return createRestErrorResponse({
            code: 'FORBIDDEN',
            category: 'authorization',
            message: `Access denied to ${plural} ${id}`,
            retryable: false,
            traceId: requestContext.traceId,
          });
        }

        const { offset, limit } = parsePagination(req.query);
        const direction = (req.query['direction'] as string) || 'outbound';

        const linkPage = await deps.linkManager.getLinks(
          id,
          linkType,
          direction as 'inbound' | 'outbound',
          { limit, offset },
          requestContext,
        );

        // Field-level redaction on link properties
        const redacted = deps.authorizationService.redactFieldsBatch(
          user.id,
          user.roles,
          linkType,
          linkPage.items as unknown as Record<string, unknown>[],
        );
        const data = redacted.map((r: { data: Record<string, unknown> }) => r.data);

        return {
          status: 200,
          body: {
            data,
            pagination: {
              totalCount: linkPage.totalCount,
              limit,
              offset,
              hasNextPage: linkPage.hasNextPage,
              hasPreviousPage: offset > 0,
            },
          },
        };
      } catch (err) {
        return wrapErrorToRest(err, ctx.requestContext.traceId);
      }
    },
  };
}

/**
 * GET /api/v1/{plural}/:id/history — version history.
 */
function generateHistoryRoute(
  obj: ObjectType,
  plural: string,
  fgaType: string,
  deps: ApiDependencies,
): RestRoute {
  return {
    method: 'GET',
    pattern: `/api/v1/${plural}/:id/history`,
    handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
      try {
        const { user, requestContext } = ctx;
        const typeName = obj.name;
        const id = req.params['id']!;

        // Authorize — user must have view access to the object
        const allowed = await deps.authorizationService.check(
          `user:${user.id}`,
          'viewer',
          `${fgaType}:${id}`,
        );
        if (!allowed) {
          return createRestErrorResponse({
            code: 'FORBIDDEN',
            category: 'authorization',
            message: `Access denied to ${typeName} ${id}`,
            retryable: false,
            traceId: requestContext.traceId,
          });
        }

        // Get current object to determine version count
        const current = await deps.objectManager.get(typeName, id, requestContext);
        if (!current) {
          return createRestErrorResponse({
            code: 'OBJECT_NOT_FOUND',
            category: 'not_found',
            message: `${typeName} ${id} not found`,
            retryable: false,
            traceId: requestContext.traceId,
          });
        }

        const currentVersion = (current._version as number) ?? 1;
        const versions: OntologyObject[] = [];

        for (let v = 1; v <= currentVersion; v++) {
          const versionObj = await deps.storage.getObjectAtVersion(
            requestContext,
            typeName,
            id,
            v,
          );
          if (versionObj) {
            versions.push(versionObj);
          }
        }

        // Field-level redaction on each version, preserving version metadata
        const redacted = deps.authorizationService.redactFieldsBatch(
          user.id,
          user.roles,
          typeName,
          versions.map((item: OntologyObject) => objectToRest(item, obj)),
        );

        let items = redacted.map((r: RedactionResult<Record<string, unknown>>, i: number) => {
          const data = r.data as Record<string, unknown>;
          // Preserve version metadata for history entries
          data._version = versions[i]?._version;
          data._updatedAt = versions[i]?._updatedAt;
          data._redactedFields = r._redactedFields.length > 0 ? r._redactedFields : null;
          data._consentRestricted = false;
          return data;
        });

        // Consent filtering
        if (deps.consentService) {
          const getPrimaryId = (item: Record<string, unknown>) => {
            const primaryField = obj.fields.find(f => isPrimaryField(f));
            return String(item[primaryField?.name ?? 'id'] ?? '');
          };
          const consentResult = await deps.consentService.filterList(
            items,
            getPrimaryId,
            DEFAULT_CONSENT_PURPOSE as DataPurpose,
            user.id,
            requestContext.tenantId,
          );
          items = consentResult.edges;
        }

        return {
          status: 200,
          body: {
            data: items,
          },
        };
      } catch (err) {
        return wrapErrorToRest(err, ctx.requestContext.traceId);
      }
    },
  };
}

/**
 * POST /api/v1/{plural}/aggregate — aggregate query.
 */
function generateAggregateRoute(
  obj: ObjectType,
  plural: string,
  fgaType: string,
  deps: ApiDependencies,
): RestRoute {
  return {
    method: 'POST',
    pattern: `/api/v1/${plural}/aggregate`,
    handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
      try {
        const { user, requestContext } = ctx;
        const typeName = obj.name;

        // Authorization: restrict aggregation to authorized objects
        const allowedIds = await resolveAllowedIds(deps, user.id, fgaType);
        if (allowedIds.length === 0) {
          return { status: 200, body: { data: { groups: [], totalGroups: 0 } } };
        }

        const body = (req.body ?? {}) as Record<string, unknown>;

        // Build AggregateQuery from body
        const rawFields = (body['fields'] ?? []) as Array<{ field: string; fn: string; alias?: string }>;
        const groupBy = body['groupBy'] as string[] | undefined;

        // Field-level authorization: reject aggregation over redacted fields
        // Check aggregate fields, groupBy, orderBy, and filter predicates
        const userFilter = body['filter'] as FilterExpression | undefined;
        const orderBy = body['orderBy'] as { field: string; direction: 'asc' | 'desc' }[] | undefined;
        const fields: AggregateField[] = rawFields.map((f) => ({
          field: f.field,
          fn: f.fn.toLowerCase() as AggregateFunction,
          alias: f.alias,
        }));
        const visibleFields = deps.authorizationService.getVisibleFields(user.id, user.roles, typeName);
        if (visibleFields) {
          const allRequestedFields = [
            ...rawFields.filter(f => f.field !== '*').map(f => f.field),
            ...(groupBy ?? []),
            ...collectFilterFields(userFilter),
            // An output alias is not a field (its inputs are checked above).
            ...aggregateSortSourceFields(orderBy, fields, obj.fields.map((f) => f.name)),
          ];
          const blocked = allRequestedFields.filter(f => !visibleFields.has(f));
          if (blocked.length > 0) {
            return createRestErrorResponse({
              code: 'FORBIDDEN',
              category: 'authorization',
              message: `Cannot aggregate over redacted fields: ${blocked.join(', ')}`,
              retryable: false,
              traceId: requestContext.traceId,
            });
          }
        }

        const primary = obj.fields.find((f) => isPrimaryField(f))?.name;
        const combinedFilter = buildAuthFilter(allowedIds, userFilter ? mapPrimaryField(userFilter, primary) : undefined);

        const query: AggregateQuery = {
          fields,
          groupBy,
          filter: combinedFilter,
          // Not mapped: an aggregate orderBy names an output alias or a
          // grouping key, which may be spelled like the primary field.
          orderBy,
          limit: body['limit'] as number | undefined,
          offset: body['offset'] as number | undefined,
        };

        const result = await deps.objectManager.aggregate(typeName, query, requestContext);

        return {
          status: 200,
          body: { data: result },
        };
      } catch (err) {
        return wrapErrorToRest(err, ctx.requestContext.traceId);
      }
    },
  };
}

/**
 * GET /api/v1/{plural}/search?q=term&fields=f1,f2&limit=20&offset=0 — full-text search.
 */
function generateSearchRoute(
  obj: ObjectType,
  plural: string,
  fgaType: string,
  deps: ApiDependencies,
): RestRoute {
  return {
    method: 'GET',
    pattern: `/api/v1/${plural}/search`,
    handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
      try {
        const { user, requestContext } = ctx;
        const typeName = obj.name;

        const q = typeof req.query['q'] === 'string' ? req.query['q'] : '';
        if (!q || q.trim().length === 0) {
          return createRestErrorResponse({
            code: 'MISSING_QUERY',
            category: 'validation',
            message: 'The "q" query parameter is required for search',
            retryable: false,
            traceId: requestContext.traceId,
          });
        }

        // Authorization: restrict search to authorized objects
        const allowedIds = await resolveAllowedIds(deps, user.id, fgaType);
        if (allowedIds.length === 0) {
          const { offset, limit } = parsePagination(req.query);
          return {
            status: 200,
            body: {
              data: [],
              pagination: { totalCount: 0, limit, offset, hasNextPage: false, hasPreviousPage: false },
            },
          };
        }

        const authFilter = buildAuthFilter(allowedIds);

        // Parse fields from comma-separated string
        const fieldsRaw = typeof req.query['fields'] === 'string' ? req.query['fields'] : undefined;
        const fields = fieldsRaw ? fieldsRaw.split(',').map((f) => f.trim()).filter((f) => f.length > 0) : undefined;

        // SEC-14: Validate search fields against redacted fields
        const visibleFields = deps.authorizationService.getVisibleFields(user.id, user.roles, typeName);
        if (visibleFields && fields) {
          const searchViolations = restrictedSearchFieldNames(fields, visibleFields, obj.fields.find((f) => isPrimaryField(f))?.name);
          if (searchViolations.length > 0) {
            return createRestErrorResponse({
              code: 'ACCESS_DENIED',
              category: 'authorization',
              message: `Cannot search on redacted fields: ${searchViolations.join(', ')}`,
              retryable: false,
              traceId: requestContext.traceId,
            });
          }
        }

        // SEC-14b: When no explicit search fields and redaction is active,
        // restrict search to visible fields only (prevents hidden field leakage).
        let searchFields = fields;
        if (!searchFields && visibleFields) {
          searchFields = visibleSearchFields(visibleFields, obj.fields);
        }

        const { offset, limit } = parsePagination(req.query);

        type Hit = { object: OntologyObject; score: number };
        type ShapedHit = { node: Record<string, unknown>; score: number };
        const searchWith = (l: number, o: number): SearchQuery => ({
          query: q, fields: searchFields, filter: authFilter, limit: l, offset: o,
        });
        const mapHits = (rawHits: Hit[]): ShapedHit[] => {
          const redacted = deps.authorizationService.redactFieldsBatch(
            user.id, user.roles, typeName,
            rawHits.map((h) => objectToRest(h.object, obj)),
          );
          return redacted.map((r: RedactionResult<Record<string, unknown>>, i: number) => {
            const data = r.data as Record<string, unknown>;
            data._redactedFields = r._redactedFields.length > 0 ? r._redactedFields : null;
            data._consentRestricted = false;
            return { node: data, score: rawHits[i]!.score };
          });
        };

        let hits: ShapedHit[];
        let totalCount: number;
        let hasNextPage: boolean;

        if (deps.consentService) {
          const getPrimaryId = (hit: ShapedHit) => {
            const primaryField = obj.fields.find(f => isPrimaryField(f));
            return String(hit.node[primaryField?.name ?? 'id'] ?? '');
          };
          const result = await paginateWithConsent<Hit, ShapedHit>(
            offset,
            limit,
            async (windowLimit) => {
              const r = await deps.objectManager.search(typeName, searchWith(windowLimit, 0), requestContext);
              return { items: r.hits as Hit[], total: r.totalCount };
            },
            async (rawHits) => {
              const consentResult = await deps.consentService!.filterList(
                mapHits(rawHits), getPrimaryId, DEFAULT_CONSENT_PURPOSE as DataPurpose,
                user.id, requestContext.tenantId,
              );
              return consentResult.edges as ShapedHit[];
            },
          );
          hits = result.items;
          totalCount = result.totalCount;
          hasNextPage = result.hasNextPage;
        } else {
          const r = await deps.objectManager.search(typeName, searchWith(limit, offset), requestContext);
          hits = mapHits(r.hits as Hit[]);
          totalCount = r.totalCount;
          hasNextPage = offset + hits.length < totalCount;
        }

        return {
          status: 200,
          body: {
            data: hits,
            pagination: {
              totalCount,
              limit,
              offset,
              hasNextPage,
              hasPreviousPage: offset > 0,
            },
          },
        };
      } catch (err) {
        return wrapErrorToRest(err, ctx.requestContext.traceId);
      }
    },
  };
}

// ─── Action routes ───

/**
 * POST /api/v1/actions/{ActionName} — execute action.
 */
function generateActionRoute(
  action: ActionType,
  schema: ParsedSchema,
  deps: ApiDependencies,
): RestRoute {
  return {
    method: 'POST',
    pattern: `/api/v1/actions/${action.name}`,
    handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
      try {
        const { user, requestContext } = ctx;
        const input = (req.body ?? {}) as Record<string, unknown>;

        const actor: ActionActor = {
          id: user.id,
          type: 'user',
          roles: user.roles,
        };

        // Derive consent from action schema — if the action has a @param whose
        // type is a configured consent-subject type (default Patient), check
        // consent for that subject under the deployment's default purpose.
        const subjectTypes = deps.consentSubjectTypes ?? DEFAULT_CONSENT_SUBJECT_TYPES;
        const subjectParam = action.fields.find(
          f => isParamField(f) && subjectTypes.includes(f.type.name),
        );
        const consentSubjectId = subjectParam
          ? String(input[subjectParam.name] ?? '')
          : undefined;
        const actionCtx: ActionContext = {
          requestContext,
          ...(consentSubjectId ? {
            consentPurpose: DEFAULT_CONSENT_PURPOSE,
            consentSubjectId,
          } : {}),
        };

        // Resolve manifest from registry — fail closed if not found
        const manifest = deps.manifestRegistry?.get(action.name);
        if (!manifest) {
          return createRestErrorResponse({
            code: 'MANIFEST_NOT_FOUND',
            category: 'not_found',
            message: `No manifest registered for action "${action.name}"`,
            retryable: false,
            traceId: requestContext.traceId,
          });
        }

        const result = await deps.actionExecutor.execute(
          manifest,
          input,
          actor,
          actionCtx,
          schema,
        );

        return {
          status: 200,
          body: {
            data: {
              success: result.success,
              actionId: result.actionId,
              errors: result.errors.length > 0 ? result.errors : null,
              affectedObjects: result.affectedObjects.map(o => ({
                typeName: o.type,
                id: o.id,
                changeType: o.changeType.toUpperCase(),
              })),
            },
          },
        };
      } catch (err) {
        return wrapErrorToRest(err, ctx.requestContext.traceId);
      }
    },
  };
}

// ─── Object Set routes ───

function objectSetToRest(def: ObjectSetDefinition): Record<string, unknown> {
  return {
    id: def.id,
    name: def.name,
    description: def.description ?? null,
    objectType: def.objectType,
    filter: def.filter ?? null,
    orderBy: def.orderBy ?? null,
    limit: def.limit ?? null,
    aggregation: def.aggregation ?? null,
    isPublic: def.isPublic,
    createdBy: def.createdBy,
    createdAt: def.createdAt,
    updatedAt: def.updatedAt,
  };
}

function generateObjectSetRoutes(schema: ParsedSchema, deps: ApiDependencies): RestRoute[] {
  return [
    // GET /api/v1/object-sets — list
    {
      method: 'GET',
      pattern: '/api/v1/object-sets',
      handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
        try {
          if (!deps.objectSetManager) {
            return { status: 200, body: { data: [] } };
          }
          const objectType = typeof req.query['objectType'] === 'string' ? req.query['objectType'] : undefined;
          const defs = await deps.objectSetManager.list(objectType, ctx.requestContext);
          return { status: 200, body: { data: defs.map(objectSetToRest) } };
        } catch (err) {
          return wrapErrorToRest(err, ctx.requestContext.traceId);
        }
      },
    },
    // GET /api/v1/object-sets/:id — get
    {
      method: 'GET',
      pattern: '/api/v1/object-sets/:id',
      handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
        try {
          if (!deps.objectSetManager) {
            return createRestErrorResponse({
              code: 'NOT_CONFIGURED',
              category: 'system',
              message: 'Object set manager is not configured',
              retryable: false,
              traceId: ctx.requestContext.traceId,
            });
          }
          const id = req.params['id']!;
          const def = await deps.objectSetManager.get(id, ctx.requestContext);
          if (!def) {
            return createRestErrorResponse({
              code: 'OBJECT_SET_NOT_FOUND',
              category: 'not_found',
              message: `Object set ${id} not found`,
              retryable: false,
              traceId: ctx.requestContext.traceId,
            });
          }
          return { status: 200, body: { data: objectSetToRest(def) } };
        } catch (err) {
          return wrapErrorToRest(err, ctx.requestContext.traceId);
        }
      },
    },
    // POST /api/v1/object-sets — create
    {
      method: 'POST',
      pattern: '/api/v1/object-sets',
      handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
        try {
          if (!deps.objectSetManager) {
            return createRestErrorResponse({
              code: 'NOT_CONFIGURED',
              category: 'system',
              message: 'Object set manager is not configured',
              retryable: false,
              traceId: ctx.requestContext.traceId,
            });
          }
          const body = (req.body ?? {}) as Record<string, unknown>;
          const def = await deps.objectSetManager.create(
            {
              name: body['name'] as string,
              description: body['description'] as string | undefined,
              objectType: body['objectType'] as string,
              filter: body['filter'] as FilterExpression | undefined,
              orderBy: body['orderBy'] as { field: string; direction: 'asc' | 'desc' }[] | undefined,
              limit: body['limit'] as number | undefined,
              aggregation: body['aggregation'] as AggregateQuery | undefined,
              isPublic: (body['isPublic'] as boolean) ?? false,
              createdBy: ctx.user.id,
              tenantId: ctx.requestContext.tenantId,
            },
            ctx.requestContext,
          );
          return { status: 201, body: { data: objectSetToRest(def) } };
        } catch (err) {
          return wrapErrorToRest(err, ctx.requestContext.traceId);
        }
      },
    },
    // PUT /api/v1/object-sets/:id — update
    {
      method: 'PUT',
      pattern: '/api/v1/object-sets/:id',
      handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
        try {
          if (!deps.objectSetManager) {
            return createRestErrorResponse({
              code: 'NOT_CONFIGURED',
              category: 'system',
              message: 'Object set manager is not configured',
              retryable: false,
              traceId: ctx.requestContext.traceId,
            });
          }
          const id = req.params['id']!;
          const body = (req.body ?? {}) as Record<string, unknown>;
          const ALLOWED_UPDATE_FIELDS = new Set(['name', 'description', 'filter', 'orderBy', 'limit', 'aggregation', 'isPublic']);
          const updates: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(body)) {
            if (value !== undefined && ALLOWED_UPDATE_FIELDS.has(key)) {
              updates[key] = value;
            }
          }
          const def = await deps.objectSetManager.update(id, updates, ctx.requestContext);
          return { status: 200, body: { data: objectSetToRest(def) } };
        } catch (err) {
          return wrapErrorToRest(err, ctx.requestContext.traceId);
        }
      },
    },
    // DELETE /api/v1/object-sets/:id — delete
    {
      method: 'DELETE',
      pattern: '/api/v1/object-sets/:id',
      handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
        try {
          if (!deps.objectSetManager) {
            return createRestErrorResponse({
              code: 'NOT_CONFIGURED',
              category: 'system',
              message: 'Object set manager is not configured',
              retryable: false,
              traceId: ctx.requestContext.traceId,
            });
          }
          const id = req.params['id']!;
          await deps.objectSetManager.delete(id, ctx.requestContext);
          return { status: 204, body: {} };
        } catch (err) {
          return wrapErrorToRest(err, ctx.requestContext.traceId);
        }
      },
    },
    // GET /api/v1/object-sets/:id/execute?limit=&offset= — run saved query
    {
      method: 'GET',
      pattern: '/api/v1/object-sets/:id/execute',
      handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
        try {
          if (!deps.objectSetManager) {
            return createRestErrorResponse({
              code: 'NOT_CONFIGURED',
              category: 'system',
              message: 'Object set manager is not configured',
              retryable: false,
              traceId: ctx.requestContext.traceId,
            });
          }
          const { user } = ctx;
          const id = req.params['id']!;

          // Look up the object set to determine the objectType for auth
          const def = await deps.objectSetManager.get(id, ctx.requestContext);
          if (!def) {
            return createRestErrorResponse({
              code: 'OBJECT_SET_NOT_FOUND',
              category: 'not_found',
              message: `Object set ${id} not found`,
              retryable: false,
              traceId: ctx.requestContext.traceId,
            });
          }

          // Validate schema type before querying storage — fail closed if unknown
          const obj = schema.objectTypes.find((o) => o.name === def.objectType);
          if (!obj) {
            return createRestErrorResponse({
              code: 'SCHEMA_TYPE_NOT_FOUND',
              category: 'system',
              message: `Object type "${def.objectType}" not found in schema`,
              retryable: false,
              traceId: ctx.requestContext.traceId,
            });
          }

          // SEC-14: the saved filter and sort may not name fields this caller
          // cannot see, as a list request's may not; checked on the names as
          // saved, before the primary-field mapping below.
          const visibleFields = deps.authorizationService.getVisibleFields(user.id, user.roles, def.objectType);
          if (visibleFields) {
            const violations = restrictedFieldNames(
              [...collectFilterFields(def.filter), ...(def.orderBy ?? []).map((o) => o.field)],
              visibleFields,
              obj.fields.find((f) => isPrimaryField(f))?.name,
            );
            if (violations.length > 0) {
              return createRestErrorResponse({
                code: 'ACCESS_DENIED',
                category: 'authorization',
                message: `Cannot filter or sort on redacted fields: ${violations.join(', ')}`,
                retryable: false,
                traceId: ctx.requestContext.traceId,
              });
            }
          }

          // Authorization: restrict results to authorized objects
          const fgaType = toSnakeCase(def.objectType);
          const allowedIds = await resolveAllowedIds(deps, user.id, fgaType);
          if (allowedIds.length === 0) {
            const { offset, limit } = parsePagination(req.query);
            return {
              status: 200,
              body: {
                data: [],
                pagination: { totalCount: 0, limit, offset, hasNextPage: false, hasPreviousPage: false },
              },
            };
          }

          const { offset, limit } = parsePagination(req.query);

          // Inject auth filter into the object set's saved filter (its primary
          // field, e.g. id, is stored as _id; see mapPrimaryField)
          const setPrimary = obj.fields.find((f) => isPrimaryField(f))?.name;
          const authFilter = buildAuthFilter(allowedIds, def.filter ? mapPrimaryField(def.filter, setPrimary) : undefined);
          const setOrderBy = mapPrimarySort(def.orderBy, setPrimary);
          const mapAndRedact = (objs: OntologyObject[]): Record<string, unknown>[] =>
            deps.authorizationService
              .redactFieldsBatch(
                user.id, user.roles, def.objectType,
                objs.map((item: OntologyObject) => objectToRest(item, obj)),
              )
              .map((r: RedactionResult<Record<string, unknown>>) => {
                const data = r.data as Record<string, unknown>;
                data._redactedFields = r._redactedFields.length > 0 ? r._redactedFields : null;
                data._consentRestricted = false;
                return data;
              });

          let items: Record<string, unknown>[];
          let totalCount: number;
          let hasNextPage: boolean;

          if (deps.consentService) {
            const getPrimaryId = (item: Record<string, unknown>) => {
              const primaryField = obj.fields.find(f => isPrimaryField(f));
              return String(item[primaryField?.name ?? 'id'] ?? '');
            };
            const result = await paginateWithConsent<OntologyObject, Record<string, unknown>>(
              offset,
              limit,
              async (windowLimit) => {
                const scan = await deps.objectManager.query(
                  def.objectType, authFilter, { limit: windowLimit, offset: 0, orderBy: setOrderBy }, ctx.requestContext,
                );
                return { items: scan.items, total: scan.totalCount };
              },
              async (raw) => {
                const consentResult = await deps.consentService!.filterList(
                  mapAndRedact(raw), getPrimaryId, DEFAULT_CONSENT_PURPOSE as DataPurpose,
                  user.id, ctx.requestContext.tenantId,
                );
                return consentResult.edges as Record<string, unknown>[];
              },
            );
            items = result.items;
            totalCount = result.totalCount;
            hasNextPage = result.hasNextPage;
          } else {
            const page = await deps.objectManager.query(
              def.objectType, authFilter, { limit, offset, orderBy: setOrderBy }, ctx.requestContext,
            );
            items = mapAndRedact(page.items);
            totalCount = page.totalCount;
            hasNextPage = offset + items.length < totalCount;
          }

          return {
            status: 200,
            body: {
              data: items,
              pagination: {
                totalCount,
                limit,
                offset,
                hasNextPage,
                hasPreviousPage: offset > 0,
              },
            },
          };
        } catch (err) {
          return wrapErrorToRest(err, ctx.requestContext.traceId);
        }
      },
    },
    // GET /api/v1/object-sets/:id/aggregate — run saved aggregation
    {
      method: 'GET',
      pattern: '/api/v1/object-sets/:id/aggregate',
      handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
        try {
          if (!deps.objectSetManager) {
            return createRestErrorResponse({
              code: 'NOT_CONFIGURED',
              category: 'system',
              message: 'Object set manager is not configured',
              retryable: false,
              traceId: ctx.requestContext.traceId,
            });
          }
          const { user } = ctx;
          const id = req.params['id']!;

          // Look up the object set for auth scoping
          const def = await deps.objectSetManager.get(id, ctx.requestContext);
          if (!def) {
            return createRestErrorResponse({
              code: 'OBJECT_SET_NOT_FOUND',
              category: 'not_found',
              message: `Object set ${id} not found`,
              retryable: false,
              traceId: ctx.requestContext.traceId,
            });
          }
          if (!def.aggregation) {
            return createRestErrorResponse({
              code: 'INVALID_OPERATION',
              category: 'validation',
              message: `Object set ${id} has no aggregation defined`,
              retryable: false,
              traceId: ctx.requestContext.traceId,
            });
          }

          // Validate schema type before querying storage
          if (!schema.objectTypes.find((o) => o.name === def.objectType)) {
            return createRestErrorResponse({
              code: 'SCHEMA_TYPE_NOT_FOUND',
              category: 'system',
              message: `Object type "${def.objectType}" not found in schema`,
              retryable: false,
              traceId: ctx.requestContext.traceId,
            });
          }

          // Authorization: restrict aggregation to authorized objects
          const fgaType = toSnakeCase(def.objectType);
          const allowedIds = await resolveAllowedIds(deps, user.id, fgaType);
          if (allowedIds.length === 0) {
            return { status: 200, body: { data: { groups: [], totalGroups: 0 } } };
          }

          // Field-level authorization: reject aggregation over redacted fields
          // Check aggregate fields, groupBy, orderBy, saved filter, and aggregation filter
          const visibleFields = deps.authorizationService.getVisibleFields(user.id, user.roles, def.objectType);
          if (visibleFields) {
            const allRequestedFields = [
              ...def.aggregation.fields.filter(f => f.field !== '*').map(f => f.field),
              ...(def.aggregation.groupBy ?? []),
              ...collectFilterFields(def.filter),
              ...collectFilterFields(def.aggregation.filter),
              // An output alias is not a field (its inputs are checked above).
              ...aggregateSortSourceFields(
                def.aggregation.orderBy,
                def.aggregation.fields,
                (schema.objectTypes.find((o) => o.name === def.objectType)?.fields ?? []).map((f) => f.name),
              ),
            ];
            const blocked = allRequestedFields.filter(f => !visibleFields.has(f));
            if (blocked.length > 0) {
              return createRestErrorResponse({
                code: 'FORBIDDEN',
                category: 'authorization',
                message: `Cannot aggregate over redacted fields: ${blocked.join(', ')}`,
                retryable: false,
                traceId: ctx.requestContext.traceId,
              });
            }
          }

          // Merge auth filter + saved filter into the aggregation query
          const aggregation = { ...def.aggregation };
          const setPrimary = schema.objectTypes
            .find((o) => o.name === def.objectType)
            ?.fields.find((f) => isPrimaryField(f))?.name;
          const savedFilter = def.filter ? mapPrimaryField(def.filter, setPrimary) : undefined;
          const authFilter = buildAuthFilter(allowedIds, savedFilter);
          if (aggregation.filter) {
            aggregation.filter = { and: [authFilter, mapPrimaryField(aggregation.filter, setPrimary)] };
          } else {
            aggregation.filter = authFilter;
          }

          const result = await deps.objectManager.aggregate(def.objectType, aggregation, ctx.requestContext);
          return { status: 200, body: { data: result } };
        } catch (err) {
          return wrapErrorToRest(err, ctx.requestContext.traceId);
        }
      },
    },
  ];
}
