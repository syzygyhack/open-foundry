/**
 * Consent-record API — v0.2.0 Epic A2.
 *
 * Governed surface to record a consent decision, replacing the documented
 * footgun where integrators INSERT GRANT rows directly into
 * `consent.consent_records`. Wraps `ConsentService.recordConsent` (a raw
 * `store.put` with no auth/audit) with a granter-role gate and an audit record
 * per write (and per denial).
 *
 * NOTE: this does NOT change the pre-admission DIRECT_CARE exemption policy
 * (`careRelation` still defaults to `viewer` from `admitted_to`). A2 makes
 * recording consent an in-platform two-step flow; it is not the same as making
 * a first admission succeed without a prior consent record / care relation.
 */

import type { DataPurpose } from '@openfoundry/spi';
import { STANDARD_DATA_PURPOSES } from '@openfoundry/spi';
import type { ApiDependencies, ResolverContext } from '../graphql/types.js';
import { DEFAULT_CONSENT_PURPOSE } from '../graphql/types.js';
import type { RestRoute, RestRequest, RestResponse } from '../rest/types.js';
import { createRestErrorResponse } from '../rest/errors.js';

/**
 * Generic default roles permitted to record consent. `admin` is the universal
 * platform role; deployments broaden this via deps.consentRecorderRoles
 * (env CONSENT_RECORDER_ROLES) rather than hardcoding domain-specific roles
 * (an NHS deployment adds nurse_in_charge / clinician).
 */
export const DEFAULT_CONSENT_RECORDER_ROLES = ['admin'] as const;

/**
 * Fail-fast validation of deployment consent configuration. Throws on states
 * that would boot but leave consent-gated reads/actions permanently broken in a
 * way operators cannot fix through the API. Called at server boot.
 */
export function assertConsentConfig(opts: {
  /** Recordable purpose vocabulary (env CONSENT_PURPOSES); undefined → standard preset. */
  consentPurposes?: readonly string[];
  /** Default purpose used for read/action consent checks. */
  defaultPurpose: string;
  /** Whether the relationship exemption is enabled. */
  exemptionEnabled: boolean;
  /** Action consent-subject types (env CONSENT_SUBJECT_TYPES). */
  consentSubjectTypes?: readonly string[];
}): void {
  // The default purpose enforced on reads/actions must be recordable, else those
  // checks demand a purpose no one can grant (router rejects out-of-vocab writes).
  if (opts.consentPurposes && !opts.consentPurposes.includes(opts.defaultPurpose)) {
    throw new Error(
      `Invalid consent config: DEFAULT_CONSENT_PURPOSE='${opts.defaultPurpose}' is not in ` +
      `CONSENT_PURPOSES=[${opts.consentPurposes.join(', ')}]. Set DEFAULT_CONSENT_PURPOSE to one of them.`,
    );
  }
  // The exemption resolves a single FGA subject-type prefix for bare ids; it
  // cannot disambiguate >1 consent-subject type.
  if (opts.exemptionEnabled && opts.consentSubjectTypes && opts.consentSubjectTypes.length > 1) {
    throw new Error(
      `Invalid consent config: the relationship exemption (CONSENT_DIRECT_CARE_EXEMPTION=true) ` +
      `supports a single CONSENT_SUBJECT_TYPES entry, got [${opts.consentSubjectTypes.join(', ')}]. ` +
      `Use one subject type, or disable the exemption.`,
    );
  }
}

export interface ConsentChangeResult {
  ok: boolean;
  code?: string;
  category?: 'validation' | 'authorization' | 'system';
  message?: string;
  data?: Record<string, unknown>;
}

interface ConsentBody {
  subject?: string;
  purpose?: string;
  decision?: string;
  evidence?: string;
}

function callerCanRecord(roles: string[], recorderRoles: readonly string[]): boolean {
  return roles.some((r) => recorderRoles.includes(r));
}

/**
 * Core consent-record logic shared by REST and GraphQL: validate → authorize
 * (recorder role) → record → audit.
 */
export async function applyConsentRecord(
  deps: ApiDependencies,
  body: unknown,
  actor: { id: string; roles: string[] },
  tenantId: string,
  traceId: string | undefined,
): Promise<ConsentChangeResult> {
  const b = (body ?? {}) as ConsentBody;
  const recorderRoles = deps.consentRecorderRoles ?? DEFAULT_CONSENT_RECORDER_ROLES;
  // Deployment-defined purpose vocabulary (env CONSENT_PURPOSES); defaults to the
  // standard NHS/UK-IG preset for back-compat. A non-NHS deployment sets its own.
  const validPurposes = deps.consentPurposes ?? STANDARD_DATA_PURPOSES;

  const subject = typeof b.subject === 'string' ? b.subject.trim() : '';
  if (!subject) {
    return { ok: false, code: 'VALIDATION_ERROR', category: 'validation', message: 'Missing required field: subject' };
  }
  const purpose = (b.purpose ?? DEFAULT_CONSENT_PURPOSE).toString();
  if (!validPurposes.includes(purpose)) {
    return { ok: false, code: 'INVALID_PURPOSE', category: 'validation', message: `Unknown purpose '${purpose}'. Valid: ${validPurposes.join(', ')}.` };
  }
  const decision = (b.decision ?? 'GRANT').toString().toUpperCase();
  if (decision !== 'GRANT' && decision !== 'DENY') {
    return { ok: false, code: 'INVALID_DECISION', category: 'validation', message: `Decision must be GRANT or DENY (got '${decision}').` };
  }
  const evidence = typeof b.evidence === 'string' ? b.evidence : undefined;

  const auditActor = { type: 'user' as const, id: actor.id, roles: actor.roles };
  // The audited object is the consent record itself (keyed by data-subject id),
  // not a domain object — keep this pack-agnostic so non-NHS consent subjects
  // (e.g. an AML Customer) are not mislabelled as 'patient' in the audit trail.
  const auditOp = { type: 'update' as const, objectType: 'consent', objectId: subject };

  if (!callerCanRecord(actor.roles, recorderRoles)) {
    await deps.auditWriter?.write({
      actor: auditActor, operation: auditOp,
      detail: { result: 'denied', denialReason: `Caller lacks a consent-recorder role (${recorderRoles.join('/')})`, after: { purpose, decision } },
      traceId,
    });
    return { ok: false, code: 'FORBIDDEN', category: 'authorization', message: `Not permitted to record consent (requires one of: ${recorderRoles.join(', ')}).` };
  }

  if (!deps.consentService) {
    return { ok: false, code: 'CONSENT_NOT_CONFIGURED', category: 'system', message: 'Consent service is not configured.' };
  }

  try {
    await deps.consentService.recordConsent(subject, purpose as DataPurpose, decision as 'GRANT' | 'DENY', evidence, tenantId);
    await deps.auditWriter?.write({
      actor: auditActor, operation: auditOp,
      detail: { result: 'success', consentDecision: decision === 'GRANT' ? 'granted' : 'denied', after: { purpose, decision, evidence } },
      traceId,
    });
    return { ok: true, data: { subject, purpose, decision, recorded: true } };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Consent write failed';
    await deps.auditWriter?.write({
      actor: auditActor, operation: auditOp,
      detail: { result: 'error', denialReason: message, after: { purpose, decision } },
      traceId,
    });
    // The audit keeps the store's message; the caller gets a generic one (a
    // connection error names hosts and ports).
    return { ok: false, code: 'CONSENT_WRITE_FAILED', category: 'system', message: 'Consent write failed' };
  }
}

/** Build the consent-record REST route (thin adapter over the core). */
export function generateConsentRoutes(deps: ApiDependencies): RestRoute[] {
  const handler = async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
    const r = await applyConsentRecord(
      deps, req.body,
      { id: ctx.user.id, roles: ctx.user.roles }, ctx.requestContext.tenantId, ctx.requestContext.traceId,
    );
    if (!r.ok) {
      return createRestErrorResponse({
        code: r.code!, category: r.category!, message: r.message!,
        retryable: r.category === 'system', traceId: ctx.requestContext.traceId,
      });
    }
    return { status: 200, body: { data: r.data! } };
  };
  return [{ method: 'POST', pattern: '/api/v1/consent', handler }];
}
