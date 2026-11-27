/**
 * Tests for the ActionExecutor pipeline (Section 5.3).
 *
 * Uses the in-memory storage provider and mock CEL client to test all 3 NHS
 * actions: AdmitPatient, DischargePatient, TransferWard.
 *
 * Also tests precondition failures, authorization failures, and
 * transaction rollback on effect failure.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import type { ParsedSchema } from '@openfoundry/odl';
import type {
  OntologyObject,
  OntologySchema,
  RequestContext,
  AuditRecord,
} from '@openfoundry/spi';

import { parseActionManifest } from '../../parser/index.js';
import { ActionExecutor, readLinkPages } from '../action-executor.js';
import type {
  ActionActor,
  ActionContext,
  SecurityLayer,
  CelEvaluator,
  CelEvalResult,
  AuditWriter,
  ActionEventPublisher,
  SideEffectHandler,
} from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures: NHS ODL Schema
// ---------------------------------------------------------------------------

const NHS_SCHEMA: ParsedSchema = {
  objectTypes: [
    {
      kind: 'objectType',
      name: 'Patient',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
        { name: 'status', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'name', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'currentWard', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [] },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
    {
      kind: 'objectType',
      name: 'Ward',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
        { name: 'name', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
    {
      kind: 'objectType',
      name: 'Bed',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
        { name: 'status', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
    {
      kind: 'objectType',
      name: 'Consultant',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
        { name: 'name', type: { name: 'String', nonNull: true, isList: false, listElementNonNull: false }, directives: [] },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
    {
      kind: 'objectType',
      name: 'DischargeRecord',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
        { name: 'patient', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'ward', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'destination', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'dischargeDate', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [] },
        { name: 'notes', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [] },
      ],
      interfaces: [],
      directives: [{ kind: 'objectType' }],
    },
  ],
  linkTypes: [
    {
      kind: 'linkType',
      name: 'AdmittedTo',
      from: 'Patient',
      to: 'Ward',
      cardinality: 'MANY_TO_ONE',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
      ],
      directives: [{ kind: 'linkType', from: 'Patient', to: 'Ward', cardinality: 'MANY_TO_ONE' }],
    },
    {
      kind: 'linkType',
      name: 'UnderCareOf',
      from: 'Patient',
      to: 'Consultant',
      cardinality: 'MANY_TO_ONE',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
      ],
      directives: [{ kind: 'linkType', from: 'Patient', to: 'Consultant', cardinality: 'MANY_TO_ONE' }],
    },
    {
      kind: 'linkType',
      name: 'OccupiesBed',
      from: 'Patient',
      to: 'Bed',
      cardinality: 'ONE_TO_ONE',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
      ],
      directives: [{ kind: 'linkType', from: 'Patient', to: 'Bed', cardinality: 'ONE_TO_ONE' }],
    },
    {
      kind: 'linkType',
      name: 'BedInWard',
      from: 'Bed',
      to: 'Ward',
      cardinality: 'MANY_TO_ONE',
      fields: [
        { name: 'id', type: { name: 'ID', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'primary' }] },
      ],
      directives: [{ kind: 'linkType', from: 'Bed', to: 'Ward', cardinality: 'MANY_TO_ONE' }],
    },
  ],
  actionTypes: [
    {
      kind: 'actionType',
      name: 'AdmitPatient',
      fields: [
        { name: 'patient', type: { name: 'Patient', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'ward', type: { name: 'Ward', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'consultant', type: { name: 'Consultant', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'bed', type: { name: 'Bed', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'reason', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
      ],
      directives: [{ kind: 'actionType' }],
    },
    {
      kind: 'actionType',
      name: 'DischargePatient',
      fields: [
        { name: 'patient', type: { name: 'Patient', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'destination', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'notes', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
      ],
      directives: [{ kind: 'actionType' }],
    },
    {
      kind: 'actionType',
      name: 'TransferWard',
      fields: [
        { name: 'patient', type: { name: 'Patient', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'toWard', type: { name: 'Ward', nonNull: true, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'toBed', type: { name: 'Bed', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
        { name: 'reason', type: { name: 'String', nonNull: false, isList: false, listElementNonNull: false }, directives: [{ kind: 'param' }] },
      ],
      directives: [{ kind: 'actionType' }],
    },
  ],
  enums: [],
  interfaces: [],
  scalars: [],
};

// SPI OntologySchema for the storage provider
const SPI_SCHEMA: OntologySchema = {
  version: 1,
  objectTypes: [
    { name: 'Patient', properties: [{ name: 'status', type: 'String' }, { name: 'name', type: 'String' }, { name: 'currentWard', type: 'String' }] },
    { name: 'Ward', properties: [{ name: 'name', type: 'String' }] },
    { name: 'Bed', properties: [{ name: 'status', type: 'String' }] },
    { name: 'Consultant', properties: [{ name: 'name', type: 'String' }] },
    { name: 'DischargeRecord', properties: [{ name: 'patient', type: 'String' }, { name: 'destination', type: 'String' }] },
  ],
  linkTypes: [
    { name: 'AdmittedTo', fromType: 'Patient', toType: 'Ward', cardinality: 'MANY_TO_MANY' },
    { name: 'UnderCareOf', fromType: 'Patient', toType: 'Consultant', cardinality: 'MANY_TO_MANY' },
    { name: 'OccupiesBed', fromType: 'Patient', toType: 'Bed', cardinality: 'ONE_TO_ONE' },
    { name: 'BedInWard', fromType: 'Bed', toType: 'Ward', cardinality: 'MANY_TO_MANY' },
  ],
};

// ---------------------------------------------------------------------------
// Fixtures: Manifest YAML
// ---------------------------------------------------------------------------

const ADMIT_PATIENT_YAML = `
action: AdmitPatient
version: 1
reversible: false

preconditions:
  - expr: "patient.status != 'ACTIVE' || patient.currentWard == null"
    error: "Patient is already admitted to a ward"
  - expr: "bed == null || bed.status == 'AVAILABLE'"
    error: "Selected bed is not available"

effects:
  - type: updateObject
    target: "patient"
    set:
      status: "ACTIVE"

  - type: createLink
    linkType: "AdmittedTo"
    from: "patient"
    to: "ward"
    properties:
      admissionDate: "now"
      reason: "params.reason"

  - type: createLink
    linkType: "UnderCareOf"
    from: "patient"
    to: "consultant"
    properties:
      assignedDate: "now"
      role: "'PRIMARY'"

  - type: updateObject
    target: "bed"
    condition: "bed != null"
    set:
      status: "OCCUPIED"

  - type: createLink
    linkType: "OccupiesBed"
    from: "patient"
    to: "bed"
    condition: "bed != null"
    properties:
      assignedAt: "now"

sideEffects:
  - name: emitAdmissionEvent
    type: event
    config:
      type: "nhs.acute.patient.admitted"
      data:
        patientId: "patient.id"
        status: "'admitted'"

rollback:
  onSideEffectFailure: LOG_AND_CONTINUE
`;

const DISCHARGE_PATIENT_YAML = `
action: DischargePatient
version: 1
reversible: false

preconditions:
  - expr: "patient.status == 'ACTIVE'"
    error: "Patient is not currently active"

effects:
  - type: updateObject
    target: "patient"
    set:
      status: "DISCHARGED"

  - type: deleteLink
    linkType: "AdmittedTo"
    filter:
      from: "patient"
      active: true
    expect: ONE

  - type: deleteLink
    linkType: "OccupiesBed"
    filter:
      from: "patient"
      active: true
    expect: ALL

  - type: deleteLink
    linkType: "UnderCareOf"
    filter:
      from: "patient"
      active: true
    expect: ALL

  - type: createObject
    objectType: "DischargeRecord"
    properties:
      patient: "patient"
      ward: "params.ward"
      destination: "params.destination"
      dischargeDate: "now"
      notes: "params.notes"

sideEffects:
  - name: emitDischargeEvent
    type: event
    config:
      type: "nhs.acute.patient.discharged"

rollback:
  onSideEffectFailure: LOG_AND_CONTINUE
`;

const TRANSFER_WARD_YAML = `
action: TransferWard
version: 1
reversible: false

preconditions:
  - expr: "patient.status == 'ACTIVE'"
    error: "Patient is not currently active"

effects:
  - type: deleteLink
    linkType: "AdmittedTo"
    filter:
      from: "patient"
      active: true
    expect: ONE

  - type: deleteLink
    linkType: "OccupiesBed"
    filter:
      from: "patient"
      active: true
    expect: ALL

  - type: createLink
    linkType: "AdmittedTo"
    from: "patient"
    to: "toWard"
    properties:
      admissionDate: "now"
      reason: "params.reason"

  - type: updateObject
    target: "toBed"
    condition: "toBed != null"
    set:
      status: "OCCUPIED"

  - type: createLink
    linkType: "OccupiesBed"
    from: "patient"
    to: "toBed"
    condition: "toBed != null"
    properties:
      assignedAt: "now"

sideEffects:
  - name: emitTransferEvent
    type: event
    config:
      type: "nhs.acute.patient.transferred"

rollback:
  onSideEffectFailure: LOG_AND_CONTINUE
`;

// AdmitPatient variant with a ROLLBACK_ALL compensation policy. A single
// object-update effect keeps the compensation assertion unambiguous: when the
// downstream side effect fails, the committed status change must be reverted.
const ADMIT_PATIENT_ROLLBACK_YAML = `
action: AdmitPatient
version: 1
reversible: false

effects:
  - type: updateObject
    target: "patient"
    set:
      status: "ACTIVE"

sideEffects:
  - name: emitAdmissionEvent
    type: event
    config:
      type: "nhs.acute.patient.admitted"

rollback:
  onSideEffectFailure: ROLLBACK_ALL
`;

// AdmitPatient variant that both updates the patient AND creates a link, under
// ROLLBACK_ALL. Exercises compensation of a CREATED link (must be removed via
// deleteLink, not mis-routed to deleteObject).
const ADMIT_PATIENT_ROLLBACK_LINK_YAML = `
action: AdmitPatient
version: 1
reversible: false

effects:
  - type: updateObject
    target: "patient"
    set:
      status: "ACTIVE"

  - type: createLink
    linkType: "AdmittedTo"
    from: "patient"
    to: "ward"
    properties:
      admissionDate: "now"
      reason: "params.reason"

sideEffects:
  - name: emitAdmissionEvent
    type: event
    config:
      type: "nhs.acute.patient.admitted"

rollback:
  onSideEffectFailure: ROLLBACK_ALL
`;

// Minimal action exercising the recordConsent effect with an opt-out CEL
// condition (consent-on-register is default-on unless the caller opts out).
const RECORD_CONSENT_YAML = `
action: RecordConsentProbe
version: 1
reversible: false

effects:
  - type: recordConsent
    subject: "patient"
    purpose: "DIRECT_CARE"
    decision: "GRANT"
    condition: "params.consent != false"
`;

// ---------------------------------------------------------------------------
// Mock CEL Evaluator
// ---------------------------------------------------------------------------

/**
 * Mock CEL evaluator that interprets simple expressions against the context.
 * Supports: dot-path access, string literals, equality, inequality, null checks,
 * boolean OR/AND, and hasRole() calls.
 */
function createMockCelEvaluator(): CelEvaluator {
  return {
    async evaluate(expression: string, variables: Record<string, unknown>): Promise<CelEvalResult> {
      try {
        const value = evalCelExpression(expression, variables);
        return { value };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function evalCelExpression(expr: string, ctx: Record<string, unknown>): unknown {
  expr = expr.trim();

  // Handle OR (||)
  if (expr.includes('||')) {
    const parts = splitTopLevel(expr, '||');
    if (parts.length > 1) {
      return parts.some((p) => evalCelExpression(p, ctx) === true);
    }
  }

  // Handle AND (&&)
  if (expr.includes('&&')) {
    const parts = splitTopLevel(expr, '&&');
    if (parts.length > 1) {
      return parts.every((p) => evalCelExpression(p, ctx) === true);
    }
  }

  // Handle != comparison
  if (expr.includes('!=')) {
    const [left, right] = expr.split('!=').map((s) => s.trim());
    if (left && right) {
      const lVal = resolveValue(left, ctx);
      const rVal = resolveValue(right, ctx);
      return lVal !== rVal;
    }
  }

  // Handle == comparison
  if (expr.includes('==')) {
    const [left, right] = expr.split('==').map((s) => s.trim());
    if (left && right) {
      const lVal = resolveValue(left, ctx);
      const rVal = resolveValue(right, ctx);
      return lVal === rVal;
    }
  }

  // Handle hasRole() calls: actor.hasRole('clinician')
  const hasRoleMatch = expr.match(/^actor\.hasRole\('(\w+)'\)$/);
  if (hasRoleMatch) {
    const role = hasRoleMatch[1]!;
    const actor = ctx['actor'] as { roles?: string[] } | undefined;
    return actor?.roles?.includes(role) ?? false;
  }

  // Simple value resolution
  return resolveValue(expr, ctx);
}

function resolveValue(expr: string, ctx: Record<string, unknown>): unknown {
  expr = expr.trim();

  // String literal: 'VALUE'
  if (expr.startsWith("'") && expr.endsWith("'")) {
    return expr.slice(1, -1);
  }

  // null literal
  if (expr === 'null') return null;
  // boolean literals
  if (expr === 'true') return true;
  if (expr === 'false') return false;

  // Dot-path: patient.status, params.reason, etc.
  const parts = expr.split('.');

  // Handle hasRole at the end
  if (parts.length >= 2 && parts[parts.length - 1]?.startsWith('hasRole(')) {
    // Already handled above
    return evalCelExpression(expr, ctx);
  }

  let current: unknown = ctx;
  for (const part of parts) {
    if (current === null || current === undefined) return null;
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }

  return current ?? null;
}

/** Split expression by operator at top level (not within quotes). */
function splitTopLevel(expr: string, op: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = '';

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (ch === "'") {
      inQuote = !inQuote;
      current += ch;
    } else if (!inQuote && ch === '(') {
      depth++;
      current += ch;
    } else if (!inQuote && ch === ')') {
      depth--;
      current += ch;
    } else if (!inQuote && depth === 0 && expr.slice(i, i + op.length) === op) {
      parts.push(current);
      current = '';
      i += op.length - 1;
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

// ---------------------------------------------------------------------------
// Mock Security Layer
// ---------------------------------------------------------------------------

function createAllowAllSecurity(): SecurityLayer {
  return {
    async checkPermission() {
      return { allowed: true };
    },
  };
}

function createDenySecurity(reason: string): SecurityLayer {
  return {
    async checkPermission() {
      return { allowed: false, reason };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Audit Writer
// ---------------------------------------------------------------------------

function createMockAuditWriter(): AuditWriter & { records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return {
    records,
    async write(record: AuditRecord) {
      records.push(record);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Side-Effect Handler
// ---------------------------------------------------------------------------

function createMockSideEffectHandler(): SideEffectHandler & { calls: Array<{ name: string; type: string; config: Record<string, unknown> }> } {
  const calls: Array<{ name: string; type: string; config: Record<string, unknown> }> = [];
  return {
    calls,
    async execute(name, type, config) {
      calls.push({ name, type, config: config as Record<string, unknown> });
      return { success: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Event Publisher
// ---------------------------------------------------------------------------

function createMockEventPublisher(): ActionEventPublisher & { events: Array<{ changeType: string; type: string; id: string }> } {
  const events: Array<{ changeType: string; type: string; id: string }> = [];
  return {
    events,
    async publishObjectChange(changeType, objectType, objectId) {
      events.push({ changeType, type: objectType, id: objectId });
    },
    async publishLinkChange(changeType, linkType, linkId) {
      events.push({ changeType, type: linkType, id: linkId });
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const REQ_CTX: RequestContext = {
  tenantId: 'nhs-trust-01',
  actorId: 'dr-smith',
  traceId: 'trace-001',
};

const ACTOR: ActionActor = {
  id: 'dr-smith',
  type: 'user',
  roles: ['clinician', 'nurse_in_charge'],
};

const ACTION_CTX: ActionContext = {
  requestContext: REQ_CTX,
};

async function setupStorage(): Promise<{
  storage: MemoryStorageProvider;
  patient: OntologyObject;
  ward: OntologyObject;
  ward2: OntologyObject;
  bed: OntologyObject;
  bed2: OntologyObject;
  consultant: OntologyObject;
}> {
  const storage = new MemoryStorageProvider();
  await storage.applySchema(REQ_CTX, SPI_SCHEMA);

  const patient = await storage.createObject(REQ_CTX, 'Patient', {
    name: 'John Smith',
    status: 'WAITING',
    currentWard: null,
  });
  const ward = await storage.createObject(REQ_CTX, 'Ward', { name: 'Ward A' });
  const ward2 = await storage.createObject(REQ_CTX, 'Ward', { name: 'Ward B' });
  const bed = await storage.createObject(REQ_CTX, 'Bed', { status: 'AVAILABLE' });
  const bed2 = await storage.createObject(REQ_CTX, 'Bed', { status: 'AVAILABLE' });
  const consultant = await storage.createObject(REQ_CTX, 'Consultant', { name: 'Dr. Jones' });

  return { storage, patient, ward, ward2, bed, bed2, consultant };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActionExecutor', () => {
  let storage: MemoryStorageProvider;
  let patient: OntologyObject;
  let ward: OntologyObject;
  let ward2: OntologyObject;
  let bed: OntologyObject;
  let bed2: OntologyObject;
  let consultant: OntologyObject;
  let auditWriter: ReturnType<typeof createMockAuditWriter>;
  let sideEffectHandler: ReturnType<typeof createMockSideEffectHandler>;
  let eventPublisher: ReturnType<typeof createMockEventPublisher>;
  let executor: ActionExecutor;

  beforeEach(async () => {
    const fixtures = await setupStorage();
    storage = fixtures.storage;
    patient = fixtures.patient;
    ward = fixtures.ward;
    ward2 = fixtures.ward2;
    bed = fixtures.bed;
    bed2 = fixtures.bed2;
    consultant = fixtures.consultant;

    auditWriter = createMockAuditWriter();
    sideEffectHandler = createMockSideEffectHandler();
    eventPublisher = createMockEventPublisher();

    executor = new ActionExecutor({
      storage,
      security: createAllowAllSecurity(),
      cel: createMockCelEvaluator(),
      auditWriter,
      sideEffectHandler,
      eventPublisher,
    });
  });

  // -------------------------------------------------------------------------
  // AdmitPatient
  // -------------------------------------------------------------------------

  describe('AdmitPatient', () => {
    it('admits a patient with bed assignment', async () => {
      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);
      expect(manifest).toBeDefined();

      const result = await executor.execute(
        manifest!,
        {
          patient: patient._id,
          ward: ward._id,
          consultant: consultant._id,
          bed: bed._id,
          reason: 'Emergency admission',
        },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.actionId).toBeTruthy();

      // Patient status should be updated to ACTIVE
      const updatedPatient = await storage.getObject(REQ_CTX, 'Patient', patient._id);
      expect(updatedPatient!.status).toBe('ACTIVE');

      // Bed status should be updated to OCCUPIED
      const updatedBed = await storage.getObject(REQ_CTX, 'Bed', bed._id);
      expect(updatedBed!.status).toBe('OCCUPIED');

      // AdmittedTo link should exist
      const admittedLinks = await storage.getLinks(REQ_CTX, patient._id, 'AdmittedTo', 'outbound');
      expect(admittedLinks.items).toHaveLength(1);
      expect(admittedLinks.items[0]!._toId).toBe(ward._id);

      // UnderCareOf link should exist
      const careLinks = await storage.getLinks(REQ_CTX, patient._id, 'UnderCareOf', 'outbound');
      expect(careLinks.items).toHaveLength(1);
      expect(careLinks.items[0]!._toId).toBe(consultant._id);
      expect(careLinks.items[0]!.role).toBe('PRIMARY');

      // OccupiesBed link should exist
      const bedLinks = await storage.getLinks(REQ_CTX, patient._id, 'OccupiesBed', 'outbound');
      expect(bedLinks.items).toHaveLength(1);
      expect(bedLinks.items[0]!._toId).toBe(bed._id);

      // Affected objects should include patient, bed, and all 3 links
      expect(result.affectedObjects).toHaveLength(5);
    });

    it('admits a patient without bed (bed param is null)', async () => {
      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);

      const result = await executor.execute(
        manifest!,
        {
          patient: patient._id,
          ward: ward._id,
          consultant: consultant._id,
          bed: null,
          reason: 'Planned admission',
        },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);

      // Patient should be ACTIVE
      const updatedPatient = await storage.getObject(REQ_CTX, 'Patient', patient._id);
      expect(updatedPatient!.status).toBe('ACTIVE');

      // Should have AdmittedTo and UnderCareOf links but NOT OccupiesBed
      const admittedLinks = await storage.getLinks(REQ_CTX, patient._id, 'AdmittedTo', 'outbound');
      expect(admittedLinks.items).toHaveLength(1);

      const bedLinks = await storage.getLinks(REQ_CTX, patient._id, 'OccupiesBed', 'outbound');
      expect(bedLinks.items).toHaveLength(0);

      // Only 3 affected: patient update, AdmittedTo link, UnderCareOf link
      expect(result.affectedObjects).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // DischargePatient
  // -------------------------------------------------------------------------

  describe('DischargePatient', () => {
    it('discharges an admitted patient', async () => {
      // First admit the patient
      const { manifest: admitManifest } = parseActionManifest(ADMIT_PATIENT_YAML);
      await executor.execute(
        admitManifest!,
        {
          patient: patient._id,
          ward: ward._id,
          consultant: consultant._id,
          bed: bed._id,
          reason: 'Emergency',
        },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      // Now discharge
      const { manifest: dischargeManifest } = parseActionManifest(DISCHARGE_PATIENT_YAML);
      expect(dischargeManifest).toBeDefined();

      const result = await executor.execute(
        dischargeManifest!,
        {
          patient: patient._id,
          destination: 'HOME',
          notes: 'Recovery complete',
          ward: 'Ward A',
        },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);

      // Patient status should be DISCHARGED
      const updatedPatient = await storage.getObject(REQ_CTX, 'Patient', patient._id);
      expect(updatedPatient!.status).toBe('DISCHARGED');

      // All links should be deleted
      const admittedLinks = await storage.getLinks(REQ_CTX, patient._id, 'AdmittedTo', 'outbound');
      expect(admittedLinks.items).toHaveLength(0);

      const bedLinks = await storage.getLinks(REQ_CTX, patient._id, 'OccupiesBed', 'outbound');
      expect(bedLinks.items).toHaveLength(0);

      const careLinks = await storage.getLinks(REQ_CTX, patient._id, 'UnderCareOf', 'outbound');
      expect(careLinks.items).toHaveLength(0);

      // A DischargeRecord should have been created
      const records = await storage.queryObjects(REQ_CTX, 'DischargeRecord', { field: 'patient', operator: 'eq', value: patient._id });
      expect(records.items).toHaveLength(1);
      expect(records.items[0]!.destination).toBe('HOME');
      expect(records.items[0]!.notes).toBe('Recovery complete');

      // affected: patient update + 3 link deletes + DischargeRecord create
      expect(result.affectedObjects).toHaveLength(5);
    });
  });

  // -------------------------------------------------------------------------
  // TransferWard
  // -------------------------------------------------------------------------

  describe('TransferWard', () => {
    it('transfers a patient from one ward to another', async () => {
      // First admit to Ward A with bed
      const { manifest: admitManifest } = parseActionManifest(ADMIT_PATIENT_YAML);
      await executor.execute(
        admitManifest!,
        {
          patient: patient._id,
          ward: ward._id,
          consultant: consultant._id,
          bed: bed._id,
          reason: 'Initial admission',
        },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      // Transfer to Ward B with bed2
      const { manifest: transferManifest } = parseActionManifest(TRANSFER_WARD_YAML);
      expect(transferManifest).toBeDefined();

      const result = await executor.execute(
        transferManifest!,
        {
          patient: patient._id,
          toWard: ward2._id,
          toBed: bed2._id,
          reason: 'Specialist care',
        },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);

      // Old AdmittedTo to Ward A should be deleted, new one to Ward B
      const admittedLinks = await storage.getLinks(REQ_CTX, patient._id, 'AdmittedTo', 'outbound');
      expect(admittedLinks.items).toHaveLength(1);
      expect(admittedLinks.items[0]!._toId).toBe(ward2._id);

      // Old OccupiesBed deleted, new one to bed2
      const bedLinks = await storage.getLinks(REQ_CTX, patient._id, 'OccupiesBed', 'outbound');
      expect(bedLinks.items).toHaveLength(1);
      expect(bedLinks.items[0]!._toId).toBe(bed2._id);

      // Bed2 should be OCCUPIED
      const updatedBed2 = await storage.getObject(REQ_CTX, 'Bed', bed2._id);
      expect(updatedBed2!.status).toBe('OCCUPIED');

      // affected: 2 link deletes + 2 link creates + bed update
      expect(result.affectedObjects).toHaveLength(5);
    });

    it('transfers a patient without assigning a new bed', async () => {
      // Admit without bed
      const { manifest: admitManifest } = parseActionManifest(ADMIT_PATIENT_YAML);
      await executor.execute(
        admitManifest!,
        {
          patient: patient._id,
          ward: ward._id,
          consultant: consultant._id,
          bed: null,
          reason: 'Initial',
        },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      const { manifest: transferManifest } = parseActionManifest(TRANSFER_WARD_YAML);

      const result = await executor.execute(
        transferManifest!,
        {
          patient: patient._id,
          toWard: ward2._id,
          toBed: null,
          reason: 'Transfer',
        },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);

      // New AdmittedTo link to ward2
      const admittedLinks = await storage.getLinks(REQ_CTX, patient._id, 'AdmittedTo', 'outbound');
      expect(admittedLinks.items).toHaveLength(1);
      expect(admittedLinks.items[0]!._toId).toBe(ward2._id);

      // No bed links
      const bedLinks = await storage.getLinks(REQ_CTX, patient._id, 'OccupiesBed', 'outbound');
      expect(bedLinks.items).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Precondition failure
  // -------------------------------------------------------------------------

  describe('precondition failures', () => {
    it('rejects admission when patient is already active', async () => {
      // First, admit the patient
      const { manifest: admitManifest } = parseActionManifest(ADMIT_PATIENT_YAML);
      await executor.execute(
        admitManifest!,
        {
          patient: patient._id,
          ward: ward._id,
          consultant: consultant._id,
          bed: null,
          reason: 'First admission',
        },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      // Verify patient is ACTIVE
      const p = await storage.getObject(REQ_CTX, 'Patient', patient._id);
      expect(p!.status).toBe('ACTIVE');

      // Try to admit again — should fail because status is ACTIVE and currentWard is set
      // We need to update currentWard on the patient to simulate the full state
      await storage.updateObject(REQ_CTX, 'Patient', patient._id, { currentWard: ward._id });

      const result = await executor.execute(
        admitManifest!,
        {
          patient: patient._id,
          ward: ward2._id,
          consultant: consultant._id,
          bed: null,
          reason: 'Second admission',
        },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.code).toBe('PRECONDITION_FAILED');
      expect(result.errors[0]!.message).toBe('Patient is already admitted to a ward');
    });

    it('rejects discharge when patient is not active', async () => {
      // Patient starts with status 'WAITING', not 'ACTIVE'
      const { manifest: dischargeManifest } = parseActionManifest(DISCHARGE_PATIENT_YAML);

      const result = await executor.execute(
        dischargeManifest!,
        {
          patient: patient._id,
          destination: 'HOME',
          notes: 'Attempted discharge',
        },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.code).toBe('PRECONDITION_FAILED');
      expect(result.errors[0]!.message).toBe('Patient is not currently active');
    });
  });

  // -------------------------------------------------------------------------
  // Authorization failure
  // -------------------------------------------------------------------------

  describe('authorization failures', () => {
    it('rejects unauthorized actor', async () => {
      const denyExecutor = new ActionExecutor({
        storage,
        security: createDenySecurity('Insufficient permissions'),
        cel: createMockCelEvaluator(),
        auditWriter,
      });

      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);

      const result = await denyExecutor.execute(
        manifest!,
        {
          patient: patient._id,
          ward: ward._id,
          consultant: consultant._id,
          bed: null,
          reason: 'Admission',
        },
        { id: 'unauthorized-user', type: 'user', roles: [] },
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.code).toBe('AUTHORIZATION_DENIED');
      expect(result.errors[0]!.message).toContain('Insufficient permissions');
    });
  });

  // -------------------------------------------------------------------------
  // Transaction rollback
  // -------------------------------------------------------------------------

  describe('transaction rollback on effect failure', () => {
    it('rolls back all effects when one fails', async () => {
      // Use a CEL evaluator that throws on a specific condition to
      // simulate a mid-transaction failure after the first effect succeeds
      const failingCel: CelEvaluator = {
        async evaluate(expression: string, variables: Record<string, unknown>): Promise<CelEvalResult> {
          // Trigger failure on a specific condition to simulate effect error
          if (expression === 'shouldFail != null') {
            throw new Error('Simulated effect failure');
          }
          // Otherwise delegate to normal evaluator for preconditions etc.
          return createMockCelEvaluator().evaluate(expression, variables);
        },
      };

      // Craft a manifest that updates patient first (success), then
      // hits a condition that throws (causing rollback)
      const failYaml = `
action: AdmitPatient
version: 1
reversible: false

effects:
  - type: updateObject
    target: "patient"
    set:
      status: "ACTIVE"

  - type: updateObject
    target: "patient"
    condition: "shouldFail != null"
    set:
      status: "FAILED"
`;
      const { manifest } = parseActionManifest(failYaml);

      const failExecutor = new ActionExecutor({
        storage,
        security: createAllowAllSecurity(),
        cel: failingCel,
        auditWriter,
      });

      // Record patient version before
      const beforePatient = await storage.getObject(REQ_CTX, 'Patient', patient._id);
      expect(beforePatient!.status).toBe('WAITING');

      // Provide all required params for AdmitPatient
      const result = await failExecutor.execute(
        manifest!,
        {
          patient: patient._id,
          ward: ward._id,
          consultant: consultant._id,
        },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(false);
      expect(result.errors[0]!.code).toBe('EFFECT_EXECUTION_ERROR');

      // Patient should be rolled back to original state
      const afterPatient = await storage.getObject(REQ_CTX, 'Patient', patient._id);
      expect(afterPatient!.status).toBe('WAITING');
    });
  });

  // -------------------------------------------------------------------------
  // deleteLink: expect ONE vs ALL
  // -------------------------------------------------------------------------

  describe('deleteLink filter resolution', () => {
    it('expect: ONE succeeds when exactly one link matches', async () => {
      // Admit patient (creates one AdmittedTo link)
      const { manifest: admitManifest } = parseActionManifest(ADMIT_PATIENT_YAML);
      await executor.execute(
        admitManifest!,
        { patient: patient._id, ward: ward._id, consultant: consultant._id, bed: null, reason: 'Test' },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      // Create a manifest that deletes with expect: ONE
      const deleteOneYaml = `
action: DischargePatient
version: 1
effects:
  - type: deleteLink
    linkType: "AdmittedTo"
    filter:
      from: "patient"
      active: true
    expect: ONE
`;
      const { manifest } = parseActionManifest(deleteOneYaml);
      const result = await executor.execute(
        manifest!,
        { patient: patient._id },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);
      const links = await storage.getLinks(REQ_CTX, patient._id, 'AdmittedTo', 'outbound');
      expect(links.items).toHaveLength(0);
    });

    it('expect: ONE fails when no links match', async () => {
      // Patient has no AdmittedTo links
      const deleteOneYaml = `
action: DischargePatient
version: 1
effects:
  - type: deleteLink
    linkType: "AdmittedTo"
    filter:
      from: "patient"
      active: true
    expect: ONE
`;
      const { manifest } = parseActionManifest(deleteOneYaml);
      const result = await executor.execute(
        manifest!,
        { patient: patient._id },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(false);
      expect(result.errors[0]!.code).toBe('EFFECT_EXECUTION_ERROR');
      expect(result.errors[0]!.message).toContain('expected exactly ONE');
    });

    /**
     * Links from the patient to `n` new wards, then (if given) to `last`, each
     * created a millisecond after the one before: getLinks orders by creation
     * time, then ID, and links made in the same millisecond can sort by ID in
     * either order, which would let `last` land on the first page.
     */
    async function seedLinks(n: number, last?: string): Promise<{ wards: string[]; lastLink?: string }> {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        let t = Date.parse('2026-01-01T00:00:00Z');
        const wards: string[] = [];
        for (let i = 0; i < n; i++) {
          vi.setSystemTime(t++);
          const w = await storage.createObject(REQ_CTX, 'Ward', { name: `Filler ${i}` });
          wards.push(w._id);
          await storage.createLink(REQ_CTX, 'AdmittedTo', patient._id, w._id);
        }
        if (last === undefined) return { wards };
        vi.setSystemTime(t++);
        const link = await storage.createLink(REQ_CTX, 'AdmittedTo', patient._id, last);
        return { wards, lastLink: link._id };
      } finally {
        vi.useRealTimers();
      }
    }

    /** The link is not on the first page of 1000 (the executor's page size). */
    async function expectOnPageTwo(linkId: string): Promise<void> {
      const first = await storage.getLinks(REQ_CTX, patient._id, 'AdmittedTo', 'outbound', { limit: 1000 });
      expect(first.hasNextPage).toBe(true);
      expect(first.items.map((l) => l._id)).not.toContain(linkId);
    }

    it('finds a matching link past the first page of getLinks', async () => {
      // 1000 links come first; the one the filter names is the 1001st, on the
      // second page (the executor reads pages of 1000; a provider returns at
      // most 1000 per page).
      const { lastLink } = await seedLinks(1000, ward._id);
      await expectOnPageTwo(lastLink!);

      const yaml = `
action: TransferWard
version: 1
effects:
  - type: deleteLink
    linkType: "AdmittedTo"
    filter:
      from: "patient"
      to: "toWard"
      active: true
    expect: ONE
`;
      const { manifest } = parseActionManifest(yaml);
      const result = await executor.execute(
        manifest!,
        { patient: patient._id, toWard: ward._id },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);
      const live = await storage.getLinks(REQ_CTX, patient._id, 'AdmittedTo', 'outbound', { limit: 1000 });
      expect(live.totalCount).toBe(1000);
      expect(live.items.map((l) => l._id)).not.toContain(lastLink);
    });

    it('expect: ALL deletes links past the first page too', async () => {
      await seedLinks(1001);
      const yaml = `
action: DischargePatient
version: 1
effects:
  - type: deleteLink
    linkType: "AdmittedTo"
    filter:
      from: "patient"
      active: true
    expect: ALL
`;
      const { manifest } = parseActionManifest(yaml);
      const result = await executor.execute(manifest!, { patient: patient._id }, ACTOR, ACTION_CTX, NHS_SCHEMA);

      expect(result.success).toBe(true);
      const left = await storage.getLinks(REQ_CTX, patient._id, 'AdmittedTo', 'outbound');
      expect(left.totalCount).toBe(0);
    });

    it('does not miss a link when an earlier one drops out of view between pages', async () => {
      const { wards, lastLink } = await seedLinks(1000, ward._id);
      const first = wards[0]!;
      await expectOnPageTwo(lastLink!);

      // After the first page is read, the first link's ward is soft-deleted,
      // which takes that link out of getLinks' default view.
      const real = storage.getLinks.bind(storage);
      let calls = 0;
      let pages = 0;
      (storage as unknown as { getLinks: typeof storage.getLinks }).getLinks = async (...args) => {
        const page = await real(...args);
        pages++;
        if (++calls === 1) await storage.deleteObject(REQ_CTX, 'Ward', first, 'soft');
        return page;
      };

      const yaml = `
action: TransferWard
version: 1
effects:
  - type: deleteLink
    linkType: "AdmittedTo"
    filter:
      from: "patient"
      to: "toWard"
      active: true
    expect: ONE
`;
      const { manifest } = parseActionManifest(yaml);
      const result = await executor.execute(
        manifest!,
        { patient: patient._id, toWard: ward._id },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(pages).toBeGreaterThanOrEqual(2);
      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('reads on after a full page even when hasNextPage says it was the last', async () => {
      // Postgres counts and pages in separate statements: a link committed
      // between them pushes one past the page while the count said 1000.
      const { lastLink } = await seedLinks(1000, ward._id);
      await expectOnPageTwo(lastLink!);
      const real = storage.getLinks.bind(storage);
      (storage as unknown as { getLinks: typeof storage.getLinks }).getLinks = async (...args) => {
        const page = await real(...args);
        return (args[4]?.offset ?? 0) === 0 ? { ...page, hasNextPage: false, totalCount: 1000 } : page;
      };

      const yaml = `
action: TransferWard
version: 1
effects:
  - type: deleteLink
    linkType: "AdmittedTo"
    filter:
      from: "patient"
      to: "toWard"
      active: true
    expect: ONE
`;
      const { manifest } = parseActionManifest(yaml);
      const result = await executor.execute(
        manifest!,
        { patient: patient._id, toWard: ward._id },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);
    });

    it('expect: ALL succeeds even when zero links match', async () => {
      // Patient has no OccupiesBed links
      const deleteAllYaml = `
action: DischargePatient
version: 1
effects:
  - type: deleteLink
    linkType: "OccupiesBed"
    filter:
      from: "patient"
      active: true
    expect: ALL
`;
      const { manifest } = parseActionManifest(deleteAllYaml);
      const result = await executor.execute(
        manifest!,
        { patient: patient._id },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Audit records
  // -------------------------------------------------------------------------

  describe('audit records', () => {
    it('writes audit record on successful action', async () => {
      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);

      const result = await executor.execute(
        manifest!,
        { patient: patient._id, ward: ward._id, consultant: consultant._id, bed: null, reason: 'Audit test' },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);
      expect(auditWriter.records).toHaveLength(1);

      const record = auditWriter.records[0]!;
      expect(record.actor.id).toBe('dr-smith');
      expect(record.actor.type).toBe('user');
      expect(record.actor.roles).toEqual(['clinician', 'nurse_in_charge']);
      expect(record.operation.type).toBe('action');
      expect(record.operation.actionType).toBe('AdmitPatient');
      expect(record.operation.actionId).toBe(result.actionId);
      expect(record.detail.result).toBe('success');
      expect(record.traceId).toBe('trace-001');
    });

    it('writes a denied audit record on authorization denial', async () => {
      const denyExecutor = new ActionExecutor({
        storage,
        security: createDenySecurity('No access'),
        cel: createMockCelEvaluator(),
        auditWriter,
      });

      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);
      const result = await denyExecutor.execute(
        manifest!,
        { patient: patient._id, ward: ward._id, consultant: consultant._id, bed: null, reason: 'Test' },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(false);
      // Denied actions must leave refusal evidence in the immutable trail (IG).
      expect(auditWriter.records).toHaveLength(1);
      const record = auditWriter.records[0]!;
      expect(record.detail.result).toBe('denied');
      expect(record.detail.denialReason).toBe('No access');
      expect(record.operation.actionType).toBe('AdmitPatient');
      expect(record.actor.id).toBe('dr-smith');
    });

    it('denies the action and audits when consent is not granted (consent stage)', async () => {
      // Step 3 of the pipeline: when a consentManager is wired and the context
      // carries a consent purpose+subject, a denied decision must abort the
      // action (CONSENT_DENIED) BEFORE any effect runs, and leave a denied audit
      // record. Previously untested — only the authorize-stage denial was.
      const denyConsent = {
        async checkConsent() { return { allowed: false }; },
        async checkConsentBatch() { return new Map(); },
        async recordConsent() { /* noop */ },
        async revokeConsent() { return {}; },
        async getConsentRecord() { return []; },
      } as unknown as import('@openfoundry/spi').ConsentManager;
      const consentExecutor = new ActionExecutor({
        storage, security: createAllowAllSecurity(), cel: createMockCelEvaluator(),
        auditWriter, sideEffectHandler, consentManager: denyConsent,
      });
      const ctxWithConsent: ActionContext = {
        requestContext: REQ_CTX,
        consentPurpose: 'DIRECT_CARE' as unknown as ActionContext['consentPurpose'],
        consentSubjectId: patient._id,
      };

      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);
      const result = await consentExecutor.execute(
        manifest!,
        { patient: patient._id, ward: ward._id, consultant: consultant._id, bed: null, reason: 'Test' },
        ACTOR, ctxWithConsent, NHS_SCHEMA,
      );

      expect(result.success).toBe(false);
      expect(result.errors?.[0]?.code).toBe('CONSENT_DENIED');
      // No effects ran: the patient was not admitted (still no current ward link).
      expect(sideEffectHandler.calls).toHaveLength(0);
      // Denied audit record with the consent-denial marker + subject id.
      expect(auditWriter.records).toHaveLength(1);
      expect(auditWriter.records[0]!.detail.result).toBe('denied');
      expect(auditWriter.records[0]!.detail.consentDecision).toBe('denied');
      expect(auditWriter.records[0]!.operation.objectId).toBe(patient._id);
    });
  });

  // -------------------------------------------------------------------------
  // Side effects
  // -------------------------------------------------------------------------

  describe('side effects', () => {
    it('executes side effects after successful action', async () => {
      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);

      const result = await executor.execute(
        manifest!,
        { patient: patient._id, ward: ward._id, consultant: consultant._id, bed: null, reason: 'Test' },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);
      expect(sideEffectHandler.calls).toHaveLength(1);
      expect(sideEffectHandler.calls[0]!.name).toBe('emitAdmissionEvent');
      expect(sideEffectHandler.calls[0]!.type).toBe('event');
    });

    it('interpolates event data against the action context (resolved IDs, not literal expressions)', async () => {
      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);

      await executor.execute(
        manifest!,
        { patient: patient._id, ward: ward._id, consultant: consultant._id, bed: null, reason: 'Test' },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      const data = sideEffectHandler.calls[0]!.config['data'] as Record<string, unknown>;
      // "patient.id" must resolve to the real id, not the literal string.
      expect(data['patientId']).toBe(patient._id);
      expect(data['patientId']).not.toBe('patient.id');
      // Quoted literal passes through unwrapped.
      expect(data['status']).toBe('admitted');
    });
  });

  // -------------------------------------------------------------------------
  // ROLLBACK_ALL compensation (CQ-24)
  // -------------------------------------------------------------------------

  describe('ROLLBACK_ALL compensation', () => {
    it('reverts committed object effects when a side effect fails', async () => {
      // The patient starts WAITING; the action commits status=ACTIVE, then the
      // downstream side effect fails. With onSideEffectFailure: ROLLBACK_ALL the
      // executor must run a compensating transaction that restores the prior
      // status — otherwise the store is left in a half-applied state.
      const failingSideEffectHandler: SideEffectHandler = {
        async execute() {
          return { success: false, error: 'downstream broker unavailable' };
        },
      };
      const rollbackExecutor = new ActionExecutor({
        storage,
        security: createAllowAllSecurity(),
        cel: createMockCelEvaluator(),
        auditWriter,
        sideEffectHandler: failingSideEffectHandler,
      });

      // Precondition: the fixture patient is WAITING.
      const before = await storage.getObject(REQ_CTX, 'Patient', patient._id);
      expect(before?.['status']).toBe('WAITING');

      const { manifest } = parseActionManifest(ADMIT_PATIENT_ROLLBACK_YAML);
      const result = await rollbackExecutor.execute(
        manifest!,
        { patient: patient._id, ward: ward._id, consultant: consultant._id, bed: null, reason: 'Test' },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(false);
      expect(result.errors?.[0]?.code).toBe('SIDE_EFFECT_FAILURE');
      expect(result.errors?.[0]?.message).toContain('Compensating transaction');

      // The committed status change was reverted by the compensating transaction.
      const after = await storage.getObject(REQ_CTX, 'Patient', patient._id);
      expect(after?.['status']).toBe('WAITING');
    });

    it('removes a created link during compensation (deleteLink, not deleteObject)', async () => {
      // Regression: the compensation loop discriminated links from objects via
      // beforeStates.has('link:<type>:<id>'), which is only populated for DELETED
      // links — so a CREATED link was mis-routed through the object branch
      // (deleteObject) and left dangling. It must be removed via deleteLink.
      const failingSideEffectHandler: SideEffectHandler = {
        async execute() {
          return { success: false, error: 'downstream broker unavailable' };
        },
      };
      const rollbackExecutor = new ActionExecutor({
        storage,
        security: createAllowAllSecurity(),
        cel: createMockCelEvaluator(),
        auditWriter,
        sideEffectHandler: failingSideEffectHandler,
      });

      const { manifest } = parseActionManifest(ADMIT_PATIENT_ROLLBACK_LINK_YAML);
      const result = await rollbackExecutor.execute(
        manifest!,
        { patient: patient._id, ward: ward._id, consultant: consultant._id, bed: null, reason: 'Test' },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(false);
      expect(result.errors?.[0]?.code).toBe('SIDE_EFFECT_FAILURE');

      // Object effect reverted...
      const after = await storage.getObject(REQ_CTX, 'Patient', patient._id);
      expect(after?.['status']).toBe('WAITING');
      // ...and the created AdmittedTo link was removed (not left dangling).
      const admittedLinks = await storage.getLinks(REQ_CTX, patient._id, 'AdmittedTo', 'outbound');
      expect(admittedLinks.items).toHaveLength(0);
    });

    it('does NOT compensate under the default LOG_AND_CONTINUE policy', async () => {
      // Contrast: the stock AdmitPatient manifest uses LOG_AND_CONTINUE, so a
      // failed side effect must NOT roll back the committed admission — it logs
      // and the action still reports failure-free effects.
      const failingSideEffectHandler: SideEffectHandler = {
        async execute() {
          return { success: false, error: 'downstream broker unavailable' };
        },
      };
      const logExecutor = new ActionExecutor({
        storage,
        security: createAllowAllSecurity(),
        cel: createMockCelEvaluator(),
        auditWriter,
        sideEffectHandler: failingSideEffectHandler,
      });

      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);
      const result = await logExecutor.execute(
        manifest!,
        { patient: patient._id, ward: ward._id, consultant: consultant._id, bed: null, reason: 'Test' },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      // LOG_AND_CONTINUE: the action succeeds despite the side-effect failure,
      // and the committed status change is retained (no compensation).
      expect(result.success).toBe(true);
      const after = await storage.getObject(REQ_CTX, 'Patient', patient._id);
      expect(after?.['status']).toBe('ACTIVE');
    });
  });

  // -------------------------------------------------------------------------
  // recordConsent effect — opt-out condition
  // -------------------------------------------------------------------------

  describe('recordConsent opt-out condition', () => {
    function createRecordingConsentManager(): import('@openfoundry/spi').ConsentManager & {
      calls: Array<{ subject: string; purpose: string; decision: string }>;
    } {
      const calls: Array<{ subject: string; purpose: string; decision: string }> = [];
      return {
        calls,
        async checkConsent() { return { allowed: true }; },
        async checkConsentBatch() { return new Map(); },
        async recordConsent(subject: string, purpose: string, decision: string) {
          calls.push({ subject, purpose, decision });
        },
        async revokeConsent() { return {}; },
        async getConsentRecord() { return []; },
      } as unknown as import('@openfoundry/spi').ConsentManager & {
        calls: Array<{ subject: string; purpose: string; decision: string }>;
      };
    }

    it('records consent for the subject when not opted out (default-on)', async () => {
      const consentManager = createRecordingConsentManager();
      const consentExecutor = new ActionExecutor({
        storage,
        security: createAllowAllSecurity(),
        cel: createMockCelEvaluator(),
        auditWriter,
        consentManager,
      });

      const { manifest } = parseActionManifest(RECORD_CONSENT_YAML);
      const result = await consentExecutor.execute(
        manifest!,
        { patient: patient._id }, // consent param omitted → default-on
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);
      expect(consentManager.calls).toHaveLength(1);
      expect(consentManager.calls[0]).toEqual({
        subject: patient._id,
        purpose: 'DIRECT_CARE',
        decision: 'GRANT',
      });
    });

    it('skips recording when the caller opts out (condition false)', async () => {
      const consentManager = createRecordingConsentManager();
      const consentExecutor = new ActionExecutor({
        storage,
        security: createAllowAllSecurity(),
        cel: createMockCelEvaluator(),
        auditWriter,
        consentManager,
      });

      const { manifest } = parseActionManifest(RECORD_CONSENT_YAML);
      const result = await consentExecutor.execute(
        manifest!,
        { patient: patient._id, consent: false }, // explicit opt-out
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);
      // condition "params.consent != false" is false → recordConsent not called.
      expect(consentManager.calls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Pipeline ordering
  // -------------------------------------------------------------------------

  describe('pipeline ordering', () => {
    it('runs authorization before preconditions', async () => {
      // If authorization fails, preconditions should NOT be evaluated
      // (prevents information leakage per spec Section 5.3)
      let preconditionEvaluated = false;

      const trackingCel: CelEvaluator = {
        async evaluate(_expression: string, _variables: Record<string, unknown>): Promise<CelEvalResult> {
          preconditionEvaluated = true;
          return { value: true };
        },
      };

      const denyExecutor = new ActionExecutor({
        storage,
        security: createDenySecurity('No access'),
        cel: trackingCel,
      });

      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);
      const result = await denyExecutor.execute(
        manifest!,
        { patient: patient._id, ward: ward._id, consultant: consultant._id, bed: null, reason: 'Test' },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(false);
      expect(result.errors[0]!.code).toBe('AUTHORIZATION_DENIED');
      expect(preconditionEvaluated).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Parameter validation
  // -------------------------------------------------------------------------

  describe('parameter validation', () => {
    it('rejects missing required parameters', async () => {
      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);

      const result = await executor.execute(
        manifest!,
        {
          // missing: patient, ward, consultant (all required)
        },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]!.code).toBe('MISSING_REQUIRED_PARAM');
    });
  });

  // -------------------------------------------------------------------------
  // Event publication
  // -------------------------------------------------------------------------

  describe('event publication', () => {
    it('publishes events for affected objects after action', async () => {
      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);

      const result = await executor.execute(
        manifest!,
        { patient: patient._id, ward: ward._id, consultant: consultant._id, bed: bed._id, reason: 'Events test' },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);
      // 5 affected objects: patient update, AdmittedTo link, UnderCareOf link, bed update, OccupiesBed link
      expect(eventPublisher.events).toHaveLength(5);
    });
  });

  // -------------------------------------------------------------------------
  // recordConsent effect (governed consent recording)
  // -------------------------------------------------------------------------

  describe('recordConsent effect', () => {
    const REGISTER_YAML = `
action: RegisterPatient
version: 1
reversible: false
effects:
  - type: createObject
    objectType: Patient
    properties:
      name: "params.name"
      status: "DISCHARGED"
  - type: recordConsent
    subject: "patient"
    purpose: "DIRECT_CARE"
    decision: "GRANT"
`;

    function makeConsentExecutor() {
      const calls: Array<{ subjectId: string; purpose: string; decision: string }> = [];
      const consentManager = {
        async checkConsent() { return { allowed: true }; },
        async checkConsentBatch() { return new Map(); },
        async recordConsent(subjectId: string, purpose: string, decision: string) { calls.push({ subjectId, purpose, decision }); },
        async revokeConsent() { return {}; },
        async getConsentRecord() { return []; },
      } as unknown as import('@openfoundry/spi').ConsentManager;
      const exec = new ActionExecutor({
        storage, security: createAllowAllSecurity(), cel: createMockCelEvaluator(), consentManager,
      });
      return { exec, calls };
    }

    it('records consent for the just-created patient', async () => {
      const { exec, calls } = makeConsentExecutor();
      const result = await exec.execute(
        parseActionManifest(REGISTER_YAML).manifest!,
        { name: 'Jane Doe' },
        ACTOR, ACTION_CTX, NHS_SCHEMA,
      );
      expect(result.success).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.purpose).toBe('DIRECT_CARE');
      expect(calls[0]!.decision).toBe('GRANT');
      // subject "patient" resolved to the created patient's id (non-empty).
      expect(calls[0]!.subjectId).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // ReBAC relationship tuple sync (graph-derived tuples from link effects)
  // -------------------------------------------------------------------------

  describe('ReBAC tuple sync', () => {
    function makeTupleExecutor(): { exec: ActionExecutor; calls: Array<{ op: string; user: string; relation: string; resource: string }> } {
      const calls: Array<{ op: string; user: string; relation: string; resource: string }> = [];
      const relationshipWriter = {
        async writeRelationship(user: string, relation: string, resource: string) { calls.push({ op: 'write', user, relation, resource }); },
        async deleteRelationship(user: string, relation: string, resource: string) { calls.push({ op: 'delete', user, relation, resource }); },
      };
      const linkTupleMap = new Map([
        ['AdmittedTo', { relation: 'admitted_to', fromType: 'patient', toType: 'ward' }],
      ]);
      const exec = new ActionExecutor({
        storage,
        security: createAllowAllSecurity(),
        cel: createMockCelEvaluator(),
        auditWriter,
        sideEffectHandler,
        eventPublisher,
        relationshipWriter,
        linkTupleMap,
      });
      return { exec, calls };
    }

    it('writes the graph-derived tuple when a mapped link is created (AdmittedTo → admitted_to)', async () => {
      const { exec, calls } = makeTupleExecutor();
      const { manifest } = parseActionManifest(ADMIT_PATIENT_YAML);

      const result = await exec.execute(
        manifest!,
        { patient: patient._id, ward: ward._id, consultant: consultant._id, bed: null, reason: 'Tuple test' },
        ACTOR,
        ACTION_CTX,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);
      // (ward:W, admitted_to, patient:P) — resource is the from-object, user the to-object.
      expect(calls).toContainEqual({
        op: 'write',
        user: `ward:${ward._id}`,
        relation: 'admitted_to',
        resource: `patient:${patient._id}`,
      });
      // UnderCareOf is unmapped → no tuple for it.
      expect(calls.every(c => c.relation === 'admitted_to')).toBe(true);
    });

    it('deletes the tuple when a mapped link is removed (discharge)', async () => {
      // Admit first (writes the tuple), then discharge (should delete it).
      const { exec, calls } = makeTupleExecutor();
      await exec.execute(
        parseActionManifest(ADMIT_PATIENT_YAML).manifest!,
        { patient: patient._id, ward: ward._id, consultant: consultant._id, bed: null, reason: 'x' },
        ACTOR, ACTION_CTX, NHS_SCHEMA,
      );
      await exec.execute(
        parseActionManifest(DISCHARGE_PATIENT_YAML).manifest!,
        { patient: patient._id, destination: 'HOME' },
        ACTOR, ACTION_CTX, NHS_SCHEMA,
      );

      expect(calls).toContainEqual({
        op: 'delete',
        user: `ward:${ward._id}`,
        relation: 'admitted_to',
        resource: `patient:${patient._id}`,
      });
    });
  });
});

describe('readLinkPages', () => {
  const links = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ _id: `l${i}` }) as unknown as import('@openfoundry/spi').OntologyLink);
  // A provider over `all` links whose hasNextPage says no on the page that
  // ends at `claimLastAt` (a stale count).
  const pages = (all: ReturnType<typeof links>, claimLastAt = all.length) =>
    async (offset: number, limit: number) => {
      const items = all.slice(offset, offset + limit);
      return { items, hasNextPage: offset + items.length < claimLastAt };
    };

  it('ends on an exactly full last page within the page budget', async () => {
    // 3 pages of 2, the last one full: the fourth read comes back empty.
    await expect(readLinkPages(pages(links(6)), 'scan', 2, 3)).resolves.toHaveLength(6);
  });

  it('fails when there are more pages than the budget', async () => {
    await expect(readLinkPages(pages(links(7)), 'scan', 2, 3)).rejects.toThrow(/did not reach its last page after 3 pages/);
  });

  it('reads past a full page whose hasNextPage is stale', async () => {
    await expect(readLinkPages(pages(links(5), 2), 'scan', 2, 5)).resolves.toHaveLength(5);
  });
});
