/**
 * FHIR R4 read-only router (Section 8.3, MVP item 13).
 *
 * Provides a framework-agnostic request handler that maps incoming HTTP
 * requests to FHIR-formatted responses backed by the Ontology Engine.
 *
 * Endpoints:
 *   GET /fhir/Patient/{id}                              → read
 *   GET /fhir/Patient?identifier=nhs-number|value        → search
 *   GET /fhir/Patient?name=value                         → search
 *   GET /fhir/Patient?birthdate=value                    → search
 *   GET /fhir/Encounter?patient=Patient/{id}             → search
 *   GET /fhir/metadata                                   → CapabilityStatement
 *   POST/PUT/DELETE any → 405 Method Not Allowed
 *
 * All endpoints pass through the same security pipeline
 * (auth, authz, consent) as the GraphQL layer.
 */

import type { OntologyObject, FilterExpression, FieldPredicate } from '@openfoundry/spi';
import { DataPurpose } from '@openfoundry/spi';
import type { ApiDependencies, AuthenticatedUserInfo } from '../graphql/types.js';
import type {
  FhirResource,
  FhirBundle,
  FhirOperationOutcome,
} from './types.js';
import { mapPatientToFhir, mapEncounterToFhir } from './mappers.js';
import { logger } from '../logger.js';
import { getAllLinks } from '../utils.js';

// ─── Request / Response types ───

export interface FhirRequest {
  method: string;
  /** Path relative to /fhir/, e.g. "Patient/abc" or "Patient" */
  path: string;
  /** Parsed query string parameters */
  query: Record<string, string>;
  /** Authenticated user from the security pipeline */
  user: AuthenticatedUserInfo;
}

export interface FhirResponse {
  status: number;
  headers: Record<string, string>;
  body: FhirResource | FhirBundle | FhirOperationOutcome | { resourceType: string; [key: string]: unknown };
}

// ─── Configuration ───

export interface FhirRouterConfig {
  deps: ApiDependencies;
  /** Base URL for fullUrl generation in bundles. Defaults to '' */
  baseUrl?: string;
}

// ─── Router factory ───

/**
 * Create a FHIR request handler.
 *
 * Returns a function that routes incoming FHIR requests to the appropriate
 * handler and returns a FHIR-formatted response.
 */
export function createFhirRouter(config: FhirRouterConfig) {
  const { deps, baseUrl = '' } = config;

  return async (req: FhirRequest): Promise<FhirResponse> => {
    // Validate authenticated user exists (SEC-09, API-01)
    if (!req.user || !req.user.id || !req.user.tenantId) {
      return operationOutcome(401, 'login', 'Authentication required');
    }

    // Read-only: reject write methods
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return methodNotAllowed(req.method);
    }

    const segments = req.path.split('/').filter(Boolean);
    const resourceType = segments[0];
    const resourceId = segments[1];

    if (!resourceType) {
      return operationOutcome(400, 'invalid', 'Missing resource type in path');
    }

    switch (resourceType) {
      case 'metadata':
        return handleCapabilityStatement(baseUrl);

      case 'Patient':
        if (resourceId) {
          return handlePatientRead(deps, req, resourceId);
        }
        return handlePatientSearch(deps, req, baseUrl);

      case 'Encounter':
        return handleEncounterSearch(deps, req, baseUrl);

      default:
        return operationOutcome(404, 'not-found', `Resource type '${resourceType}' is not supported`);
    }
  };
}

// ─── Patient handlers ───

async function handlePatientRead(
  deps: ApiDependencies,
  req: FhirRequest,
  id: string,
): Promise<FhirResponse> {
  try {
    // Authorization check
    const allowed = await deps.authorizationService.check(
      `user:${req.user.id}`,
      'viewer',
      `patient:${id}`,
    );
    if (!allowed) {
      return operationOutcome(403, 'forbidden', `Access denied to Patient ${id}`);
    }

    const ctx = {
      tenantId: req.user.tenantId,
      actorId: req.user.id,
      traceId: `fhir-${Date.now()}`,
    };

    const obj = await deps.objectManager.get('Patient', id, ctx);
    if (!obj) {
      return operationOutcome(404, 'not-found', `Patient/${id} not found`);
    }

    // Field-level redaction
    const { data } = deps.authorizationService.redactFields(
      req.user.id,
      req.user.roles,
      'Patient',
      obj as unknown as Record<string, unknown>,
    );

    // Consent check (if service available)
    if (deps.consentService) {
      const consent = await deps.consentService.checkSingleObject(
        data,
        id,
        DataPurpose.DIRECT_CARE,
        req.user.id,
        req.user.tenantId,
      );
      if (consent._consentRestricted) {
        return operationOutcome(403, 'forbidden', 'Consent denied for this patient');
      }
    }

    const patient = mapPatientToFhir(data as unknown as OntologyObject);

    return {
      status: 200,
      headers: fhirHeaders(),
      body: patient,
    };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'FHIR Patient read error');
    return operationOutcome(500, 'exception', 'Internal server error');
  }
}

async function handlePatientSearch(
  deps: ApiDependencies,
  req: FhirRequest,
  baseUrl: string,
): Promise<FhirResponse> {
  try {
    const ctx = {
      tenantId: req.user.tenantId,
      actorId: req.user.id,
      traceId: `fhir-${Date.now()}`,
    };

    // Build filter from FHIR search parameters
    const searchFilter = buildPatientFilter(req.query);
    if (!searchFilter) {
      return operationOutcome(400, 'invalid', 'At least one search parameter is required (identifier, name, birthdate)');
    }

    // SEC-14: Validate search parameters against visible fields
    // Reject searches that filter on redacted fields (prevents inference attacks)
    const visibleFields = deps.authorizationService.getVisibleFields(req.user.id, req.user.roles, 'Patient');
    if (visibleFields) {
      const searchedFields = extractSearchFilterFields(req.query);
      const blocked = searchedFields.filter(f => !visibleFields.has(f));
      if (blocked.length > 0) {
        return operationOutcome(403, 'forbidden', `Cannot search on redacted fields: ${blocked.join(', ')}`);
      }
    }

    // Authorization: get list of patients user can view
    const allowedObjects = await deps.authorizationService.listObjects(
      `user:${req.user.id}`,
      'viewer',
      'patient',
    );

    const allowedIds = allowedObjects.map((o: string) => {
      const parts = o.split(':');
      return parts[parts.length - 1];
    }).filter((id): id is string => id !== undefined && id !== '');

    if (allowedIds.length === 0) {
      return {
        status: 200,
        headers: fhirHeaders(),
        body: { resourceType: 'Bundle', type: 'searchset', total: 0 } as FhirBundle,
      };
    }

    // Combine authorization filter with search filter
    const idFilter: FieldPredicate = { field: '_id', operator: 'in', value: allowedIds };
    const combinedFilter: FilterExpression = {
      and: [idFilter, searchFilter],
    };

    const page = await deps.objectManager.query(
      'Patient',
      combinedFilter,
      { limit: 100, offset: 0 },
      ctx,
    );

    // Redact fields for all results
    const redacted = deps.authorizationService.redactFieldsBatch(
      req.user.id,
      req.user.roles,
      'Patient',
      page.items as unknown as Record<string, unknown>[],
    );

    // Consent filtering — exclude patients that the user lacks consent for.
    // NOTE: Applied after pagination — see Encounter handler for details.
    let consentFiltered = redacted;
    if (deps.consentService) {
      const consentResult = await deps.consentService.filterList(
        redacted.map((r: { data: Record<string, unknown> }) => r.data),
        (item: Record<string, unknown>) => String(item._id ?? item.id ?? ''),
        DataPurpose.DIRECT_CARE,
        req.user.id,
        req.user.tenantId,
      );
      consentFiltered = consentResult.edges.map((item: Record<string, unknown>) => ({ data: item, _redactedFields: [] as string[] }));
    }

    const entries = consentFiltered.map((r: { data: Record<string, unknown> }) => {
      const patient = mapPatientToFhir(r.data as unknown as OntologyObject);
      return {
        fullUrl: baseUrl ? `${baseUrl}/Patient/${patient.id}` : undefined,
        resource: patient,
      };
    });

    const bundle: FhirBundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: entries.length,
      entry: entries.length > 0 ? entries : undefined,
    };

    return {
      status: 200,
      headers: fhirHeaders(),
      body: bundle,
    };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'FHIR Patient search error');
    return operationOutcome(500, 'exception', 'Internal server error');
  }
}

// ─── Encounter handlers ───

async function handleEncounterSearch(
  deps: ApiDependencies,
  req: FhirRequest,
  baseUrl: string,
): Promise<FhirResponse> {
  try {
    const patientParam = req.query['patient'];
    if (!patientParam) {
      return operationOutcome(400, 'invalid', 'The "patient" search parameter is required for Encounter search');
    }

    // Extract patient ID from "Patient/{id}" format
    const patientId = patientParam.replace(/^Patient\//, '');
    if (!patientId) {
      return operationOutcome(400, 'invalid', 'Invalid patient reference format');
    }

    const ctx = {
      tenantId: req.user.tenantId,
      actorId: req.user.id,
      traceId: `fhir-${Date.now()}`,
    };

    // Authorization: check user can view this patient
    const allowed = await deps.authorizationService.check(
      `user:${req.user.id}`,
      'viewer',
      `patient:${patientId}`,
    );
    if (!allowed) {
      return operationOutcome(403, 'forbidden', `Access denied to Patient ${patientId}`);
    }

    // Synthesize FHIR Encounters from AdmittedTo links (Patient→Ward).
    // The NHS acute schema models admissions as AdmittedTo links, not a
    // separate Encounter object type.
    // includeDeleted so discharged admissions (soft-deleted AdmittedTo links)
    // surface as finished Encounters — keeps parity with the CDM Encounter
    // projection. Both storage providers soft-delete links.
    // All pages: history comes oldest first, so one page of past admissions
    // could otherwise push out the current one.
    const admissions = await getAllLinks(
      deps.linkManager, patientId, 'AdmittedTo', 'outbound', { includeDeleted: true }, ctx,
    );

    // Convert links to OntologyObject-shaped records for the mapper.
    // AdmittedTo link properties: admissionDate, expectedDischarge, reason.
    const encounterObjects = admissions.map(link => ({
      _tenantId: link._tenantId,
      _type: 'Encounter',
      _id: link._id,
      _version: link._version,
      _createdAt: link._createdAt,
      _updatedAt: link._updatedAt,
      patientId,
      admissionDate: link.admissionDate,
      expectedDischarge: link.expectedDischarge,
      reason: link.reason,
      wardId: link._toId,
      // Derive status: if link is soft-deleted, the patient was discharged
      status: link._deletedAt ? 'DISCHARGED' : 'ACTIVE',
      dischargedAt: link._deletedAt ?? undefined,
    })) as unknown as Record<string, unknown>[];

    // Consent filtering on the patient (the consent subject).
    // NOTE: Consent is applied after storage pagination — see Patient search.
    let filteredItems: { data: Record<string, unknown> }[];
    if (deps.consentService) {
      const consentResult = await deps.consentService.filterList(
        encounterObjects,
        () => patientId,
        DataPurpose.DIRECT_CARE,
        req.user.id,
        req.user.tenantId,
      );
      filteredItems = consentResult.edges.map((item: Record<string, unknown>) => ({ data: item }));
    } else {
      filteredItems = encounterObjects.map(obj => ({ data: obj }));
    }

    const entries = filteredItems.map((r: { data: Record<string, unknown> }) => {
      const encounter = mapEncounterToFhir(r.data as unknown as OntologyObject, patientId);
      return {
        fullUrl: baseUrl ? `${baseUrl}/Encounter/${encounter.id}` : undefined,
        resource: encounter,
      };
    });

    const bundle: FhirBundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: entries.length,
      entry: entries.length > 0 ? entries : undefined,
    };

    return {
      status: 200,
      headers: fhirHeaders(),
      body: bundle,
    };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'FHIR Encounter search error');
    return operationOutcome(500, 'exception', 'Internal server error');
  }
}

// ─── Search filter builders ───

/**
 * Build an SPI FilterExpression from FHIR Patient search parameters.
 *
 * Supported parameters:
 *   - identifier: system|value format (e.g. "nhs-number|1234567890" or full system URI)
 *   - name: string match on name field
 *   - birthdate: exact match on dateOfBirth field
 */
export function buildPatientFilter(
  query: Record<string, string>,
): FilterExpression | null {
  const conditions: FieldPredicate[] = [];

  if (query['identifier']) {
    const identifier = query['identifier'];
    // Format: system|value or just value
    const pipeIndex = identifier.indexOf('|');
    if (pipeIndex >= 0) {
      const value = identifier.substring(pipeIndex + 1);
      conditions.push({ field: 'nhsNumber', operator: 'eq', value });
    } else {
      conditions.push({ field: 'nhsNumber', operator: 'eq', value: identifier });
    }
  }

  if (query['name']) {
    conditions.push({ field: 'name', operator: 'contains', value: query['name'] });
  }

  if (query['birthdate']) {
    conditions.push({ field: 'dateOfBirth', operator: 'eq', value: query['birthdate'] });
  }

  if (conditions.length === 0) return null;
  if (conditions.length === 1) return conditions[0]!;
  return { and: conditions };
}

/**
 * Extract the SPI field names that a FHIR search query would filter on.
 * Maps FHIR parameter names to the underlying ontology field names.
 */
function extractSearchFilterFields(query: Record<string, string>): string[] {
  const fields: string[] = [];
  if (query['identifier']) fields.push('nhsNumber');
  if (query['name']) fields.push('name');
  if (query['birthdate']) fields.push('dateOfBirth');
  if (query['patient']) fields.push('_id'); // Encounter by patient — not a redactable field
  return fields;
}

// ─── Helpers ───

function fhirHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/fhir+json; charset=utf-8',
  };
}

function methodNotAllowed(method: string): FhirResponse {
  return {
    status: 405,
    headers: {
      ...fhirHeaders(),
      Allow: 'GET, HEAD',
    },
    body: {
      resourceType: 'OperationOutcome',
      issue: [
        {
          severity: 'error',
          code: 'not-supported',
          diagnostics: `Method ${method} is not allowed. This FHIR endpoint is read-only.`,
        },
      ],
    },
  };
}

// ─── CapabilityStatement (GET /fhir/metadata) ───

function handleCapabilityStatement(baseUrl: string): FhirResponse {
  return {
    status: 200,
    headers: fhirHeaders(),
    body: {
      resourceType: 'CapabilityStatement',
      id: 'openfoundry',
      status: 'active',
      date: new Date().toISOString().split('T')[0],
      kind: 'instance',
      fhirVersion: '4.0.1',
      format: ['json'],
      implementation: {
        description: 'Open Foundry FHIR R4 read-only facade',
        url: baseUrl || undefined,
      },
      rest: [
        {
          mode: 'server',
          resource: [
            {
              type: 'Patient',
              profile: 'https://fhir.nhs.uk/StructureDefinition/NHSDigital-Patient',
              interaction: [
                { code: 'read' },
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'identifier', type: 'token' },
                { name: 'name', type: 'string' },
                { name: 'birthdate', type: 'date' },
              ],
            },
            {
              type: 'Encounter',
              profile: 'https://fhir.nhs.uk/StructureDefinition/NHSDigital-Encounter',
              interaction: [
                { code: 'search-type' },
              ],
              searchParam: [
                { name: 'patient', type: 'reference' },
              ],
            },
          ],
        },
      ],
    },
  };
}

function operationOutcome(
  status: number,
  code: string,
  diagnostics: string,
): FhirResponse {
  return {
    status,
    headers: fhirHeaders(),
    body: {
      resourceType: 'OperationOutcome',
      issue: [
        {
          severity: 'error',
          code,
          diagnostics,
        },
      ],
    },
  };
}
