/**
 * FDP/CDM read-only projection router (Stage 1 item S1.0).
 *
 * Emits the Open Foundry operational ontology in CDM shape, driven by the
 * mapping profile. Read-only; passes through the same auth / redaction /
 * consent pipeline as the FHIR and GraphQL layers.
 *
 * Endpoints (addressed by Open Foundry source type for unambiguous routing;
 * each record's `resourceType` carries the CDM resource name):
 *   GET /api/v1/cdm/metadata                  → profile + compatibility matrix + gap register
 *   GET /api/v1/cdm/{SourceType}              → list projection (object-kind)
 *   GET /api/v1/cdm/{SourceType}/{id}         → single projection (object-kind)
 *   GET /api/v1/cdm/{SourceType}/export       → dataset export (object-kind), ?format=ndjson|csv
 *   GET /api/v1/cdm/Encounter?patient={id}    → admission projection (link-kind, via AdmittedTo)
 */

import type { FilterExpression, FieldPredicate } from '@openfoundry/spi';
import { DataPurpose } from '@openfoundry/spi';
import type { ApiDependencies, AuthenticatedUserInfo } from '../graphql/types.js';
import { logger } from '../logger.js';
import { getAllLinks, toSnakeCase } from '../utils.js';
import { NHS_ACUTE_CDM_PROFILE } from './profile.js';
import { projectToCdm, findMappingBySourceType } from './mappers.js';
import type { CdmRecord } from './types.js';

export interface CdmRequest {
  method: string;
  /** Path relative to /api/v1/cdm/, e.g. "Patient/abc" or "Patient". */
  path: string;
  query: Record<string, string>;
  /** Authenticated user; undefined for the public metadata endpoint. */
  user?: AuthenticatedUserInfo;
}

export interface CdmResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface CdmRouterConfig {
  deps: ApiDependencies;
}

const QUERY_LIMIT = 100;
/**
 * Row cap for dataset export. Larger sets are truncated to this many rows and
 * the response flags truncation (X-CDM-Export-Truncated). A paged/streaming
 * export would be needed to lift the cap.
 */
const EXPORT_LIMIT = 10_000;

/** Export formats supported by the dataset-export route. */
const EXPORT_FORMATS = ['ndjson', 'csv'] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json; charset=utf-8' };
}

function error(status: number, message: string): CdmResponse {
  return { status, headers: jsonHeaders(), body: { error: { code: status, message } } };
}

/** Object-kind source types exposed via list/by-id routes. */
export const OBJECT_SOURCE_TYPES = NHS_ACUTE_CDM_PROFILE.resources
  .filter(r => r.sourceKind === 'object')
  .map(r => r.sourceType);

/**
 * Build the public CDM metadata body (profile + compatibility matrix + gap
 * register). Shared by the REST router and the GraphQL cdmMetadata resolver.
 */
export function buildCdmMetadata(): Record<string, unknown> {
  const profile = NHS_ACUTE_CDM_PROFILE;
  return {
    profileVersion: profile.profileVersion,
    cdmVersion: profile.cdmVersion,
    cdmStatus: profile.cdmStatus,
    subset: profile.subset,
    resources: profile.resources.map(r => ({
      cdmResource: r.cdmResource,
      sourceType: r.sourceType,
      sourceKind: r.sourceKind,
      note: r.note,
      fields: r.fields,
    })),
    gaps: profile.gaps,
  };
}

export function createCdmRouter(config: CdmRouterConfig) {
  const { deps } = config;

  return async (req: CdmRequest): Promise<CdmResponse> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return error(405, 'The CDM projection is read-only.');
    }

    const segments = req.path.split('/').filter(Boolean);
    const head = segments[0];
    const id = segments[1];

    if (!head) {
      return error(400, 'Missing CDM resource in path.');
    }

    // Public metadata: profile, compatibility matrix, gap register.
    if (head === 'metadata') {
      return {
        status: 200,
        headers: jsonHeaders(),
        body: buildCdmMetadata(),
      };
    }

    // All data endpoints require authentication.
    if (!req.user || !req.user.id || !req.user.tenantId) {
      return error(401, 'Authentication required.');
    }

    // Encounter is link-kind (derived from AdmittedTo), addressed by ?patient.
    if (head === 'Encounter') {
      return handleEncounterSearch(deps, req, req.user);
    }

    // Object-kind resources.
    if (!OBJECT_SOURCE_TYPES.includes(head)) {
      return error(404, `CDM source type '${head}' is not exposed. Known: ${OBJECT_SOURCE_TYPES.join(', ')}, Encounter.`);
    }

    // Dataset export: GET /cdm/{SourceType}/export?format=ndjson|csv
    if (id === 'export') {
      const requested = (req.query['format'] ?? 'ndjson').toLowerCase();
      if (!EXPORT_FORMATS.includes(requested as ExportFormat)) {
        return error(400, `Unsupported export format '${requested}'. Use one of: ${EXPORT_FORMATS.join(', ')}.`);
      }
      return handleObjectExport(deps, req.user, head, requested as ExportFormat);
    }

    return id
      ? handleObjectRead(deps, req.user, head, id)
      : handleObjectList(deps, req.user, head);
  };
}

function ctxFor(user: AuthenticatedUserInfo) {
  return { tenantId: user.tenantId, actorId: user.id, traceId: `cdm-${Date.now()}` };
}

/** Patient is the consent subject; other types are not consent-gated here. */
function isConsentSubject(sourceType: string): boolean {
  return sourceType === 'Patient';
}

export async function handleObjectRead(
  deps: ApiDependencies,
  user: AuthenticatedUserInfo,
  sourceType: string,
  id: string,
): Promise<CdmResponse> {
  try {
    // FGA type names are snake_case (matches ODL→OpenFGA codegen + nhs-roles.fga,
    // e.g. DischargeRecord → discharge_record).
    const fgaType = toSnakeCase(sourceType);
    const allowed = await deps.authorizationService.check(`user:${user.id}`, 'viewer', `${fgaType}:${id}`);
    if (!allowed) return error(403, `Access denied to ${sourceType} ${id}`);

    const ctx = ctxFor(user);
    const obj = await deps.objectManager.get(sourceType, id, ctx);
    if (!obj) return error(404, `${sourceType}/${id} not found`);

    const { data } = deps.authorizationService.redactFields(
      user.id, user.roles, sourceType, obj as unknown as Record<string, unknown>,
    );

    if (deps.consentService && isConsentSubject(sourceType)) {
      const consent = await deps.consentService.checkSingleObject(
        data, id, DataPurpose.DIRECT_CARE, user.id, user.tenantId,
      );
      if (consent._consentRestricted) return error(403, 'Consent denied for this record.');
    }

    const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, sourceType)!;
    const record = projectToCdm(data as Record<string, unknown>, mapping, NHS_ACUTE_CDM_PROFILE);
    return { status: 200, headers: jsonHeaders(), body: record };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'CDM object read error');
    return error(500, 'Internal server error');
  }
}

/**
 * Result of {@link collectObjectRecords}. `capped` is true when the underlying
 * query returned at least `limit` rows — i.e. more matching rows may exist
 * beyond the page — so callers can signal truncation rather than silently
 * returning a partial set.
 */
interface CollectedRecords {
  records: CdmRecord[];
  capped: boolean;
}

/**
 * Fetch the authorised, redacted, consent-filtered, CDM-projected records for an
 * object-kind source type. Shared by the list and export routes.
 *
 * Queries `limit + 1` rows so a full page can be distinguished from a page that
 * exactly fills the limit; the extra row is dropped and `capped` reflects
 * whether rows were left behind (measured before redaction/consent so the
 * signal is honest regardless of how many rows those stages remove).
 */
async function collectObjectRecords(
  deps: ApiDependencies,
  user: AuthenticatedUserInfo,
  sourceType: string,
  limit: number,
): Promise<CollectedRecords> {
  const ctx = ctxFor(user);
  const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, sourceType)!;
  const fgaType = toSnakeCase(sourceType);
  const allowedObjects = await deps.authorizationService.listObjects(`user:${user.id}`, 'viewer', fgaType);

  // '*' sentinel (dev stub / unrestricted) → no id filter; otherwise restrict.
  const unrestricted = allowedObjects.includes('*');
  const allowedIds = unrestricted
    ? []
    : allowedObjects
        .map(o => o.split(':').pop())
        .filter((v): v is string => !!v);

  if (!unrestricted && allowedIds.length === 0) {
    return { records: [], capped: false };
  }

  // Match-all pass-through (also excludes soft-deleted) mirrors the REST
  // route generator; when restricted, filter by the authorized id set.
  const filter: FilterExpression = unrestricted
    ? ({ field: '_deleted_at', operator: 'exists', value: false } as FieldPredicate)
    : ({ field: '_id', operator: 'in', value: allowedIds } as FieldPredicate);

  const page = await deps.objectManager.query(
    sourceType,
    filter,
    { limit: limit + 1, offset: 0 },
    ctx,
  );

  // Whether the query hit the cap (more rows may exist); drop the probe row.
  const capped = page.items.length > limit;
  const items = capped ? page.items.slice(0, limit) : page.items;

  const redacted = deps.authorizationService.redactFieldsBatch(
    user.id, user.roles, sourceType, items as unknown as Record<string, unknown>[],
  );

  let rows = redacted.map(r => r.data);

  if (deps.consentService && isConsentSubject(sourceType)) {
    const consentResult = await deps.consentService.filterList(
      rows,
      (item: Record<string, unknown>) => String(item['_id'] ?? item['id'] ?? ''),
      DataPurpose.DIRECT_CARE, user.id, user.tenantId,
    );
    rows = consentResult.edges as Record<string, unknown>[];
  }

  return { records: rows.map(r => projectToCdm(r, mapping, NHS_ACUTE_CDM_PROFILE)), capped };
}

export async function handleObjectList(
  deps: ApiDependencies,
  user: AuthenticatedUserInfo,
  sourceType: string,
): Promise<CdmResponse> {
  try {
    const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, sourceType)!;
    const { records, capped } = await collectObjectRecords(deps, user, sourceType, QUERY_LIMIT);
    return {
      status: 200,
      headers: jsonHeaders(),
      body: { resourceType: mapping.cdmResource, total: records.length, truncated: capped, records },
    };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'CDM object list error');
    return error(500, 'Internal server error');
  }
}

/**
 * Dataset export for an object-kind source type as NDJSON or CSV. Reuses the
 * same auth / redaction / consent / projection pipeline as the list route, so
 * an export never leaks anything the list route would not.
 */
export async function handleObjectExport(
  deps: ApiDependencies,
  user: AuthenticatedUserInfo,
  sourceType: string,
  format: ExportFormat,
): Promise<CdmResponse> {
  try {
    const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, sourceType)!;
    const { records, capped } = await collectObjectRecords(deps, user, sourceType, EXPORT_LIMIT);
    const filenameBase = `${mapping.cdmResource}-${sourceType}`;

    // The export is capped at EXPORT_LIMIT rows. If the underlying query hit the
    // cap, signal truncation explicitly (header + warning) so a consumer never
    // mistakes a partial extract for a complete one.
    if (capped) {
      logger.warn(
        { sourceType, limit: EXPORT_LIMIT },
        'CDM export truncated at EXPORT_LIMIT — extract is incomplete',
      );
    }
    const truncationHeaders: Record<string, string> = {
      'X-CDM-Export-Truncated': String(capped),
      'X-CDM-Export-Limit': String(EXPORT_LIMIT),
    };

    if (format === 'csv') {
      return {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filenameBase}.csv"`,
          ...truncationHeaders,
        },
        body: toCsv(mapping.fields.map(f => f.cdmField), records),
      };
    }

    // NDJSON: one full CDM record (incl. _provenance) per line.
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filenameBase}.ndjson"`,
        ...truncationHeaders,
      },
      body: records.map(r => JSON.stringify(r)).join('\n'),
    };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'CDM object export error');
    return error(500, 'Internal server error');
  }
}

/**
 * Serialise CDM records to CSV. Columns are the resource's mapped CDM fields
 * plus `resourceType`/`id` and a flattened `_lossyFields` provenance column.
 * Nested values are JSON-encoded; the full structured form is in NDJSON.
 */
function toCsv(cdmFields: string[], records: CdmRecord[]): string {
  const columns = ['resourceType', 'id', ...cdmFields.filter(c => c !== 'id'), '_lossyFields'];
  const escape = (value: unknown): string => {
    if (value === undefined || value === null) return '';
    let str: string;
    if (value instanceof Date) {
      str = value.toISOString();
    } else if (typeof value === 'object') {
      str = JSON.stringify(value);
    } else {
      str = String(value);
    }
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const header = columns.join(',');
  const lines = records.map(rec => {
    const row = rec as unknown as Record<string, unknown>;
    return columns
      .map(col => {
        if (col === '_lossyFields') return escape((rec._provenance?.lossyFields ?? []).join(';'));
        return escape(row[col]);
      })
      .join(',');
  });
  return [header, ...lines].join('\n');
}

export async function handleEncounterSearch(
  deps: ApiDependencies,
  req: CdmRequest,
  user: AuthenticatedUserInfo,
): Promise<CdmResponse> {
  try {
    const patientParam = req.query['patient'];
    if (!patientParam) {
      return error(400, 'The "patient" query parameter is required for Encounter projection.');
    }
    const patientId = patientParam.replace(/^Patient\//, '');
    if (!patientId) return error(400, 'Invalid patient reference.');

    const allowed = await deps.authorizationService.check(`user:${user.id}`, 'viewer', `patient:${patientId}`);
    if (!allowed) return error(403, `Access denied to Patient ${patientId}`);

    const ctx = ctxFor(user);
    // includeDeleted so discharged admissions (soft-deleted AdmittedTo links)
    // are returned and mapped to status=finished. Both storage providers
    // soft-delete links.
    // All pages: history comes oldest first, so one page of past admissions
    // could otherwise push out the current one.
    const admissions = await getAllLinks(
      deps.linkManager, patientId, 'AdmittedTo', 'outbound', { includeDeleted: true, pageSize: QUERY_LIMIT }, ctx,
    );

    // Flatten links to object shape for the profile-driven projection
    // (same approach as the FHIR Encounter path).
    const encounterObjects = admissions.map(link => ({
      _id: link._id,
      _version: link._version,
      _updatedAt: link._updatedAt,
      patientId,
      wardId: link._toId,
      admissionDate: link.admissionDate,
      expectedDischarge: link.expectedDischarge,
      reason: link.reason,
      status: link._deletedAt ? 'DISCHARGED' : 'ACTIVE',
    })) as unknown as Record<string, unknown>[];

    let rows = encounterObjects;
    if (deps.consentService) {
      const consentResult = await deps.consentService.filterList(
        rows, () => patientId, DataPurpose.DIRECT_CARE, user.id, user.tenantId,
      );
      rows = consentResult.edges as Record<string, unknown>[];
    }

    const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'AdmittedTo')!;
    const records: CdmRecord[] = rows.map(r => projectToCdm(r, mapping, NHS_ACUTE_CDM_PROFILE));

    return {
      status: 200,
      headers: jsonHeaders(),
      body: { resourceType: 'Encounter', total: records.length, records },
    };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'CDM Encounter search error');
    return error(500, 'Internal server error');
  }
}
