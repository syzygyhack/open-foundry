/**
 * FDP/CDM mapping profile for the NHS acute operational subset (S1.0).
 *
 * Declarative mapping from the `nhs-acute` ODL ontology to an FDP/CDM-shaped
 * read view. This is the machine-readable counterpart to the human-readable
 * canonical mapping document at `docs/nhs/cdm-mapping-profile.md`.
 *
 * Operational subset (per plan S1.0): Patient, Ward, Bed, Admission, Discharge,
 * Transfer, Staff, Encounter. Transfer is action-only in the ODL model and
 * Staff is consultant-only — both are recorded in the gap register rather than
 * fabricated as resources.
 */

import type { CdmMappingProfile } from './types.js';

export const NHS_ACUTE_CDM_PROFILE: CdmMappingProfile = {
  // Bumped to 0.2.0 for the Epic B mapping-surface changes (first-class
  // Transfer, structured family/given, Consultant identifier/role alignment,
  // and the Staff→Practitioner mapping). Carried into every record's
  // _provenance.profileVersion so consumers can distinguish the semantics.
  profileVersion: '0.2.0',
  cdmVersion: 'fdp-cdm-draft',
  cdmStatus:
    'DAPB4121 draft-in-progress; this profile pins a placeholder revision label. ' +
    'Revalidate against published CDM artefacts (default cadence: quarterly).',
  subset: ['Patient', 'Ward', 'Bed', 'Admission', 'Discharge', 'Transfer', 'Staff', 'Encounter'],

  resources: [
    {
      cdmResource: 'Patient',
      sourceType: 'Patient',
      sourceKind: 'object',
      fields: [
        { cdmField: 'id', sourceField: '_id' },
        { cdmField: 'nhsNumber', sourceField: 'nhsNumber', note: 'Local-number-only patients should be flagged provisional upstream (connector concern, not enforced here).' },
        { cdmField: 'name', sourceField: 'name', note: 'Full display name; structured components are carried in family/given (v0.2.0 B2).' },
        { cdmField: 'family', sourceField: 'family', note: 'Surname (structured-name decomposition, v0.2.0 B2).' },
        { cdmField: 'given', sourceField: 'given', lossy: true, note: 'One or more forenames, space-separated; CDM/FHIR model given as a list — consumers split on whitespace.' },
        { cdmField: 'birthDate', sourceField: 'dateOfBirth' },
        {
          cdmField: 'status',
          sourceField: 'status',
          enumMap: { ACTIVE: 'active', DISCHARGED: 'inactive', DECEASED: 'deceased', TRANSFERRED: 'active' },
          lossy: true,
          note: 'TRANSFERRED collapses to active; CDM has no direct equivalent for the OF transfer lifecycle state.',
        },
        { cdmField: 'triageCategory', sourceField: 'triageCategory', lossy: true, note: 'NHS-local triage categories (P1–P4); not a canonical CDM-coded field.' },
      ],
    },
    {
      cdmResource: 'Location',
      sourceType: 'Ward',
      sourceKind: 'object',
      note: 'Ward projected as a CDM Location of kind "ward".',
      fields: [
        { cdmField: 'id', sourceField: '_id' },
        { cdmField: 'kind', sourceField: '__const_ward', note: 'Constant "ward" (see projection).' },
        { cdmField: 'name', sourceField: 'name' },
        { cdmField: 'specialty', sourceField: 'specialty' },
        { cdmField: 'capacity', sourceField: 'capacity' },
      ],
    },
    {
      cdmResource: 'Location',
      sourceType: 'Bed',
      sourceKind: 'object',
      note: 'Bed projected as a CDM Location of kind "bed".',
      fields: [
        { cdmField: 'id', sourceField: '_id' },
        { cdmField: 'kind', sourceField: '__const_bed', note: 'Constant "bed" (see projection).' },
        { cdmField: 'identifier', sourceField: 'number' },
        { cdmField: 'bedType', sourceField: 'type' },
        {
          cdmField: 'status',
          sourceField: 'status',
          enumMap: { AVAILABLE: 'available', OCCUPIED: 'occupied', CLEANING: 'unavailable', OUT_OF_SERVICE: 'unavailable' },
          lossy: true,
          note: 'CLEANING and OUT_OF_SERVICE both collapse to "unavailable".',
        },
      ],
    },
    {
      cdmResource: 'Practitioner',
      sourceType: 'Consultant',
      sourceKind: 'object',
      note: 'Consultant projected as CDM Practitioner (senior clinical staff).',
      fields: [
        { cdmField: 'id', sourceField: '_id' },
        { cdmField: 'identifier', sourceField: 'gmcNumber', note: 'GMC registration number.' },
        { cdmField: 'name', sourceField: 'name', lossy: true, note: 'Single free-text name; not decomposed.' },
        { cdmField: 'role', sourceField: '__const_PHYSICIAN', note: 'Consultants are physicians (constant).' },
        { cdmField: 'specialty', sourceField: 'specialty' },
      ],
    },
    {
      cdmResource: 'Practitioner',
      sourceType: 'Staff',
      sourceKind: 'object',
      note: 'General clinical/operational staff projected as CDM Practitioner (v0.2.0 B4) — nurses, AHPs, healthcare assistants, administrative staff, porters.',
      fields: [
        { cdmField: 'id', sourceField: '_id' },
        { cdmField: 'identifier', sourceField: 'staffId', note: 'Local staff/professional identifier.' },
        { cdmField: 'name', sourceField: 'name', lossy: true, note: 'Single free-text name; not decomposed.' },
        { cdmField: 'role', sourceField: 'role', note: 'StaffRole category (nurse, AHP, admin, …).' },
        { cdmField: 'specialty', sourceField: 'specialty' },
      ],
    },
    {
      cdmResource: 'Discharge',
      sourceType: 'DischargeRecord',
      sourceKind: 'object',
      fields: [
        { cdmField: 'id', sourceField: '_id' },
        { cdmField: 'patient', sourceField: 'patient' },
        { cdmField: 'location', sourceField: 'ward' },
        {
          cdmField: 'destination',
          sourceField: 'destination',
          enumMap: { HOME: 'home', CARE_HOME: 'care-home', VIRTUAL_WARD: 'virtual-ward', TRANSFER: 'transfer', DECEASED: 'deceased' },
        },
        { cdmField: 'dischargeDate', sourceField: 'dischargeDate' },
        { cdmField: 'notes', sourceField: 'notes', lossy: true, note: 'Free-text clinical notes; no canonical CDM structure.' },
      ],
    },
    {
      cdmResource: 'Transfer',
      sourceType: 'Transfer',
      sourceKind: 'object',
      note: 'First-class Transfer record written by the TransferWard action (v0.2.0 B1).',
      fields: [
        { cdmField: 'id', sourceField: '_id' },
        { cdmField: 'patient', sourceField: 'patient' },
        { cdmField: 'sourceLocation', sourceField: 'fromWard' },
        { cdmField: 'destinationLocation', sourceField: 'toWard' },
        { cdmField: 'transferDate', sourceField: 'transferDate' },
        { cdmField: 'reason', sourceField: 'reason', lossy: true, note: 'Free-text reason; no canonical CDM structure.' },
      ],
    },
    {
      cdmResource: 'Encounter',
      sourceType: 'AdmittedTo',
      sourceKind: 'link',
      note: 'Encounter (admission) derived from the AdmittedTo link, mirroring the FHIR Encounter projection. Status derived from link soft-delete state.',
      fields: [
        { cdmField: 'id', sourceField: '_id' },
        { cdmField: 'patient', sourceField: 'patientId' },
        { cdmField: 'location', sourceField: 'wardId' },
        { cdmField: 'admissionDate', sourceField: 'admissionDate' },
        { cdmField: 'expectedDischarge', sourceField: 'expectedDischarge' },
        { cdmField: 'reason', sourceField: 'reason', lossy: true, note: 'Free-text reason; not terminology-coded.' },
        {
          cdmField: 'status',
          sourceField: 'status',
          enumMap: { ACTIVE: 'in-progress', DISCHARGED: 'finished' },
          note: 'Derived: ACTIVE while the link is live, DISCHARGED once soft-deleted.',
        },
      ],
    },
  ],

  gaps: [
    {
      area: 'Admission',
      issue: 'Admission is not a distinct resource — it is surfaced as the CDM Encounter projected from the AdmittedTo link (GET /api/v1/cdm/Encounter?patient={id}). There is no separate /Admission route.',
      fallback: 'Treat Encounter as the admission record. A distinct Admission resource is only warranted if the CDM separates them.',
    },
    {
      area: 'Transfer',
      issue: 'RESOLVED (v0.2.0 B1): the TransferWard action now writes a first-class Transfer object (patient, fromWard, toWard, transferDate, reason), projected as the CDM Transfer resource.',
      fallback: 'No longer a gap. Transfers are queryable directly and via the CDM Transfer projection.',
    },
    {
      area: 'Staff',
      issue: 'RESOLVED (v0.2.0 B4): a general Staff type (StaffRole: nurse, physician, AHP, healthcare assistant, administrative, porter) projects to CDM Practitioner alongside Consultant. Practitioner name is still a single free-text string (not decomposed).',
      fallback: 'No longer a coverage gap. Practitioner-name decomposition (family/given) remains a later refinement.',
    },
    {
      area: 'Patient.name',
      issue: 'RESOLVED (v0.2.0 B2): Patient now carries structured `family` and `given` components alongside the full `name`. `given` holds one or more space-separated forenames (CDM/FHIR model given as a list); `prefix`/`suffix` are not yet modelled.',
      fallback: 'Consumers split `given` on whitespace for the canonical list form. Prefix/suffix remain out of scope.',
    },
    {
      area: 'Patient.identifier',
      issue: 'NHS Number is optional in the ODL schema; local-number-only patients are not flagged provisional at projection time.',
      fallback: 'Provisional-identity flagging is a connector/ingestion concern (PDS resolution), handled upstream of this profile.',
    },
    {
      area: 'Terminology',
      issue: 'Coded fields (triage, discharge destination, reason) are free strings or local enums, not validated against SNOMED CT / dm+d / ODS.',
      fallback: 'Terminology validation is added at the connector layer (S1.2) and the full CDM coverage stage (S2.2).',
    },
  ],
};
