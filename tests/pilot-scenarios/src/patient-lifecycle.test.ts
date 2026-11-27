/**
 * Patient Lifecycle scenario tests (MVP Section 7.1).
 *
 * Tests the full patient journey:
 *   Sync from PAS -> Admit -> Transfer -> Discharge
 *
 * Runs against the in-memory stack (no Docker required).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import { ActionExecutor, parseActionManifest } from '@openfoundry/actions';
import type { ActionManifest } from '@openfoundry/actions';
import type { OntologyObject, RequestContext } from '@openfoundry/spi';

import {
  NHS_SCHEMA,
  SPI_SCHEMA,
  ADMIT_PATIENT_YAML,
  DISCHARGE_PATIENT_YAML,
  TRANSFER_WARD_YAML,
  createMockCelEvaluator,
  createAllowAllSecurity,
  createMockSideEffectHandler,
  createMockAuditWriter,
  createMockEventPublisher,
  createRequestContext,
  createClinicianActor,
  createActionContext,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// Parse manifests (extract .manifest from ManifestValidationResult)
// ---------------------------------------------------------------------------

function mustParseManifest(yaml: string): ActionManifest {
  const result = parseActionManifest(yaml);
  if (!result.valid || !result.manifest) {
    throw new Error(`Failed to parse manifest: ${result.errors.map(e => e.message).join(', ')}`);
  }
  return result.manifest;
}

const admitManifest = mustParseManifest(ADMIT_PATIENT_YAML);
const dischargeManifest = mustParseManifest(DISCHARGE_PATIENT_YAML);
const transferManifest = mustParseManifest(TRANSFER_WARD_YAML);
const actor = createClinicianActor();

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let storage: MemoryStorageProvider;
let executor: ActionExecutor;
let reqCtx: RequestContext;
let sideEffects: ReturnType<typeof createMockSideEffectHandler>;
let auditWriter: ReturnType<typeof createMockAuditWriter>;
let eventPublisher: ReturnType<typeof createMockEventPublisher>;

// Track generated IDs for seeded reference data
let wardAId: string;
let wardBId: string;
let bed1Id: string;
let bed5Id: string;
let consultantId: string;

beforeEach(async () => {
  storage = new MemoryStorageProvider();
  reqCtx = createRequestContext();
  sideEffects = createMockSideEffectHandler();
  auditWriter = createMockAuditWriter();
  eventPublisher = createMockEventPublisher();

  executor = new ActionExecutor({
    storage,
    security: createAllowAllSecurity(),
    cel: createMockCelEvaluator(),
    sideEffectHandler: sideEffects,
    auditWriter,
    eventPublisher,
  });

  await storage.applySchema(reqCtx, SPI_SCHEMA);

  // Seed reference data (capture generated IDs)
  const txn = await storage.beginTransaction(reqCtx);
  const wardA = await txn.createObject('Ward', { name: 'Ward A', specialty: 'General', capacity: 20 });
  const wardB = await txn.createObject('Ward', { name: 'Ward B', specialty: 'Cardiology', capacity: 15 });
  const bed1 = await txn.createObject('Bed', { number: 'A-1', status: 'AVAILABLE' });
  const bed5 = await txn.createObject('Bed', { number: 'B-5', status: 'AVAILABLE' });
  const consultant = await txn.createObject('Consultant', { name: 'Dr Smith', gmcNumber: 'GMC123', specialty: 'General' });
  await txn.commit();

  wardAId = wardA._id;
  wardBId = wardB._id;
  bed1Id = bed1._id;
  bed5Id = bed5._id;
  consultantId = consultant._id;
});

// ---------------------------------------------------------------------------
// 7.1 -- Patient Lifecycle
// ---------------------------------------------------------------------------

describe('Section 7.1: Patient Lifecycle', () => {
  describe('GIVEN a patient exists in PAS with status "not admitted"', () => {
    it('WHEN PAS data syncs to the ontology, THEN a Patient object exists with status DISCHARGED', async () => {
      // Simulate PAS sync by creating a patient directly (CDC path)
      const txn = await storage.beginTransaction(reqCtx);
      const created = await txn.createObject('Patient', {
        nhsNumber: '1234567890',
        name: 'Jane Doe',
        dateOfBirth: '1990-05-15',
        status: 'DISCHARGED',
      });
      await txn.commit();

      const patient = await storage.getObject(reqCtx, 'Patient', created._id);
      expect(patient).not.toBeNull();
      expect(patient!.status).toBe('DISCHARGED');
      expect(patient!.nhsNumber).toBe('1234567890');
      expect(patient!.name).toBe('Jane Doe');
    });
  });

  describe('GIVEN a synced Patient object', () => {
    let patient: OntologyObject;
    let patientId: string;

    beforeEach(async () => {
      const txn = await storage.beginTransaction(reqCtx);
      const created = await txn.createObject('Patient', {
        nhsNumber: '1234567890',
        name: 'Jane Doe',
        dateOfBirth: '1990-05-15',
        status: 'DISCHARGED',
      });
      await txn.commit();
      patientId = created._id;
      patient = (await storage.getObject(reqCtx, 'Patient', patientId))!;
    });

    it('WHEN AdmitPatient executes, THEN status=ACTIVE, links exist, bed=OCCUPIED, audit+event emitted', async () => {
      const ctx = createActionContext(reqCtx);
      const result = await executor.execute(
        admitManifest,
        { patient: patientId, ward: wardAId, bed: bed1Id, consultant: consultantId, reason: 'Chest pain' },
        actor,
        ctx,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);

      // Patient.status == ACTIVE
      const updated = await storage.getObject(reqCtx, 'Patient', patientId);
      expect(updated!.status).toBe('ACTIVE');

      // AdmittedTo link exists from Patient to Ward-A
      const admittedLinks = await storage.getLinks(reqCtx, patientId, 'AdmittedTo', 'outbound');
      expect(admittedLinks.items.length).toBe(1);
      expect(admittedLinks.items[0]!._toId).toBe(wardAId);

      // OccupiesBed link exists from Patient to Bed-1
      const bedLinks = await storage.getLinks(reqCtx, patientId, 'OccupiesBed', 'outbound');
      expect(bedLinks.items.length).toBe(1);
      expect(bedLinks.items[0]!._toId).toBe(bed1Id);

      // UnderCareOf link exists from Patient to Dr-Smith
      const careLinks = await storage.getLinks(reqCtx, patientId, 'UnderCareOf', 'outbound');
      expect(careLinks.items.length).toBe(1);
      expect(careLinks.items[0]!._toId).toBe(consultantId);

      // Bed-1.status == OCCUPIED
      const bed = await storage.getObject(reqCtx, 'Bed', bed1Id);
      expect(bed!.status).toBe('OCCUPIED');

      // Audit record exists
      expect(auditWriter.records.length).toBeGreaterThanOrEqual(1);
      const auditRec = auditWriter.records[0]!;
      expect(auditRec.actor.id).toBe(actor.id);
      expect(auditRec.operation.type).toBe('action');
      expect(auditRec.operation.actionType).toBe('AdmitPatient');

      // CloudEvent nhs.acute.patient.admitted was emitted
      const admissionEvent = sideEffects.events.find(e => e.name === 'emitAdmissionEvent');
      expect(admissionEvent).toBeDefined();
      expect(admissionEvent!.config.type).toBe('nhs.acute.patient.admitted');
    });
  });

  describe('GIVEN an admitted patient on Ward-A', () => {
    let patientId: string;

    beforeEach(async () => {
      // Create and admit patient
      const txn = await storage.beginTransaction(reqCtx);
      const created = await txn.createObject('Patient', {
        nhsNumber: '1234567890',
        name: 'Jane Doe',
        dateOfBirth: '1990-05-15',
        status: 'DISCHARGED',
      });
      await txn.commit();
      patientId = created._id;

      const ctx = createActionContext(reqCtx);
      await executor.execute(
        admitManifest,
        { patient: patientId, ward: wardAId, bed: bed1Id, consultant: consultantId },
        actor,
        ctx,
        NHS_SCHEMA,
      );

      // Reset trackers
      sideEffects.events.length = 0;
      auditWriter.records.length = 0;
      eventPublisher.events.length = 0;
    });

    it('WHEN TransferWard executes, THEN old links soft-deleted, new links created, history available', async () => {
      const ctx = createActionContext(reqCtx);
      const result = await executor.execute(
        transferManifest,
        { patient: patientId, toWard: wardBId, toBed: bed5Id },
        actor,
        ctx,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);

      // New AdmittedTo link to Ward-B exists
      const admittedLinks = await storage.getLinks(reqCtx, patientId, 'AdmittedTo', 'outbound');
      const activeAdmitted = admittedLinks.items.filter(l => !l._deletedAt);
      expect(activeAdmitted.length).toBe(1);
      expect(activeAdmitted[0]!._toId).toBe(wardBId);

      // New OccupiesBed link to Bed-5 exists
      const bedLinks = await storage.getLinks(reqCtx, patientId, 'OccupiesBed', 'outbound');
      const activeBed = bedLinks.items.filter(l => !l._deletedAt);
      expect(activeBed.length).toBe(1);
      expect(activeBed[0]!._toId).toBe(bed5Id);

      // Old AdmittedTo link to Ward-A no longer active
      const allAdmittedLinks = await storage.getLinks(reqCtx, patientId, 'AdmittedTo', 'outbound');
      const linksToWardA = allAdmittedLinks.items.filter(l => l._toId === wardAId);
      expect(linksToWardA.length).toBe(0);

      // ...but the Ward-A admission remains as history (soft-deleted)
      const history = await storage.getLinks(reqCtx, patientId, 'AdmittedTo', 'outbound', { includeDeleted: true });
      const wardAHistory = history.items.filter(l => l._toId === wardAId);
      expect(wardAHistory.length).toBe(1);
      expect(wardAHistory[0]!._deletedAt).toBeDefined();

      // Patient still has status ACTIVE after transfer
      const afterTransfer = await storage.getObject(reqCtx, 'Patient', patientId);
      expect(afterTransfer!.status).toBe('ACTIVE');
    });
  });

  describe('GIVEN an admitted patient', () => {
    let patientId: string;

    beforeEach(async () => {
      // Create and admit patient
      const txn = await storage.beginTransaction(reqCtx);
      const created = await txn.createObject('Patient', {
        nhsNumber: '1234567890',
        name: 'Jane Doe',
        dateOfBirth: '1990-05-15',
        status: 'DISCHARGED',
      });
      await txn.commit();
      patientId = created._id;

      const ctx = createActionContext(reqCtx);
      await executor.execute(
        admitManifest,
        { patient: patientId, ward: wardAId, bed: bed1Id, consultant: consultantId },
        actor,
        ctx,
        NHS_SCHEMA,
      );

      // Reset trackers
      sideEffects.events.length = 0;
      auditWriter.records.length = 0;
      eventPublisher.events.length = 0;
    });

    it('WHEN DischargePatient executes, THEN status=DISCHARGED, links deleted, DischargeRecord created', async () => {
      const ctx = createActionContext(reqCtx);
      const result = await executor.execute(
        dischargeManifest,
        { patient: patientId, destination: 'HOME', notes: 'Recovered well', ward: wardAId },
        actor,
        ctx,
        NHS_SCHEMA,
      );

      expect(result.success).toBe(true);

      // Patient.status == DISCHARGED
      const patient = await storage.getObject(reqCtx, 'Patient', patientId);
      expect(patient!.status).toBe('DISCHARGED');

      // All active AdmittedTo links soft-deleted
      const admittedLinks = await storage.getLinks(reqCtx, patientId, 'AdmittedTo', 'outbound');
      const activeAdmitted = admittedLinks.items.filter(l => !l._deletedAt);
      expect(activeAdmitted.length).toBe(0);

      // The admission survives as history: this is what FHIR/CDM project as a
      // finished Encounter and GraphQL's Patient.admissions returns.
      const admissionHistory = await storage.getLinks(reqCtx, patientId, 'AdmittedTo', 'outbound', { includeDeleted: true });
      expect(admissionHistory.items.length).toBe(1);
      expect(admissionHistory.items[0]!._toId).toBe(wardAId);
      expect(admissionHistory.items[0]!._deletedAt).toBeDefined();

      // All active OccupiesBed links soft-deleted
      const bedLinks = await storage.getLinks(reqCtx, patientId, 'OccupiesBed', 'outbound');
      const activeBed = bedLinks.items.filter(l => !l._deletedAt);
      expect(activeBed.length).toBe(0);

      // All active UnderCareOf links soft-deleted
      const careLinks = await storage.getLinks(reqCtx, patientId, 'UnderCareOf', 'outbound');
      const activeCare = careLinks.items.filter(l => !l._deletedAt);
      expect(activeCare.length).toBe(0);

      // DischargeRecord created
      const dischargeRecords = await storage.queryObjects(reqCtx, 'DischargeRecord', {});
      expect(dischargeRecords.items.length).toBe(1);
      expect(dischargeRecords.items[0]!.destination).toBe('HOME');
      expect(dischargeRecords.items[0]!.patient).toBe(patientId);

      // Discharge event emitted
      const dischargeEvent = sideEffects.events.find(e => e.name === 'emitDischargeEvent');
      expect(dischargeEvent).toBeDefined();
    });
  });
});
