/**
 * Shared test fixtures for SPI conformance tests.
 */

import type { RequestContext, OntologySchema } from '@openfoundry/spi';

// ---------------------------------------------------------------------------
// Request contexts
// ---------------------------------------------------------------------------

export const tenantA: RequestContext = { tenantId: 'conformance-tenant-a', actorId: 'actor-a', traceId: 'trace-a' };
export const tenantB: RequestContext = { tenantId: 'conformance-tenant-b', actorId: 'actor-b', traceId: 'trace-b' };
export const tenantC: RequestContext = { tenantId: 'conformance-tenant-c', actorId: 'actor-c', traceId: 'trace-c' };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Base schema used across most conformance tests.
 *
 * Written as the ODL loader would produce it: ODL scalar names (String, Int,
 * Float, Boolean) and a required `id: ID` property on every link type (ODL rule
 * 11 requires `id: ID! @primary` on a LinkType). The Postgres provider maps
 * property columns from these names and falls back to TEXT for names it does
 * not know, so lowercase names made every declared property a TEXT column. Its
 * link tables have an `id` column only when the link type declares one.
 */
export const baseSchema: OntologySchema = {
  version: 1,
  objectTypes: [
    {
      name: 'Patient',
      properties: [
        { name: 'name', type: 'String', required: true },
        { name: 'age', type: 'Int' },
        { name: 'status', type: 'String' },
        { name: 'email', type: 'String' },
        { name: 'score', type: 'Float' },
        { name: 'active', type: 'Boolean' },
        { name: 'tags', type: 'String' },
        { name: 'nhsNumber', type: 'String' },
      ],
    },
    {
      name: 'CareTeam',
      properties: [
        { name: 'name', type: 'String', required: true },
        { name: 'specialty', type: 'String' },
        { name: 'capacity', type: 'Int' },
      ],
    },
    {
      name: 'Appointment',
      properties: [
        { name: 'date', type: 'String' },
        { name: 'duration', type: 'Int' },
        { name: 'status', type: 'String' },
        { name: 'notes', type: 'String' },
      ],
    },
    {
      name: 'Medication',
      properties: [
        { name: 'name', type: 'String', required: true },
        { name: 'dosage', type: 'String' },
        { name: 'frequency', type: 'String' },
      ],
    },
    {
      name: 'Observation',
      properties: [
        { name: 'code', type: 'String', required: true },
        { name: 'value', type: 'Float' },
        { name: 'unit', type: 'String' },
        { name: 'recordedAt', type: 'String' },
      ],
    },
  ],
  linkTypes: [
    {
      name: 'AssignedTo',
      fromType: 'Patient',
      toType: 'CareTeam',
      cardinality: 'MANY_TO_MANY',
      properties: [{ name: 'id', type: 'ID', required: true }, { name: 'role', type: 'String' }],
    },
    {
      name: 'PrimaryDoctor',
      fromType: 'Patient',
      toType: 'CareTeam',
      cardinality: 'ONE_TO_ONE',
      properties: [{ name: 'id', type: 'ID', required: true }],
    },
    {
      name: 'HasAppointment',
      fromType: 'Patient',
      toType: 'Appointment',
      cardinality: 'ONE_TO_MANY',
      properties: [{ name: 'id', type: 'ID', required: true }],
    },
    {
      name: 'Prescribes',
      fromType: 'CareTeam',
      toType: 'Medication',
      cardinality: 'MANY_TO_MANY',
      properties: [
        { name: 'id', type: 'ID', required: true },
        { name: 'prescribedAt', type: 'String' },
        { name: 'reason', type: 'String' },
      ],
    },
    {
      name: 'HasObservation',
      fromType: 'Patient',
      toType: 'Observation',
      cardinality: 'ONE_TO_MANY',
      properties: [{ name: 'id', type: 'ID', required: true }],
    },
    {
      name: 'TeamLead',
      fromType: 'CareTeam',
      toType: 'CareTeam',
      cardinality: 'ONE_TO_ONE',
      properties: [{ name: 'id', type: 'ID', required: true }],
    },
  ],
};

/** Schema v2 adds a new object type (non-breaking migration). */
export const schemaV2: OntologySchema = {
  version: 2,
  objectTypes: [
    ...baseSchema.objectTypes,
    {
      name: 'Referral',
      properties: [
        { name: 'reason', type: 'String', required: true },
        { name: 'urgency', type: 'String' },
        { name: 'status', type: 'String' },
      ],
    },
  ],
  linkTypes: [
    ...baseSchema.linkTypes,
    {
      name: 'ReferredBy',
      fromType: 'Referral',
      toType: 'CareTeam',
      cardinality: 'MANY_TO_MANY',
      properties: [{ name: 'id', type: 'ID', required: true }],
    },
  ],
};

/** Schema v3 adds another link type. */
export const schemaV3: OntologySchema = {
  version: 3,
  objectTypes: schemaV2.objectTypes,
  linkTypes: [
    ...schemaV2.linkTypes,
    {
      name: 'Supervises',
      fromType: 'CareTeam',
      toType: 'CareTeam',
      cardinality: 'ONE_TO_MANY',
      properties: [{ name: 'id', type: 'ID', required: true }],
    },
  ],
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTestFixtures() {
  return {
    tenantA,
    tenantB,
    tenantC,
    baseSchema,
    schemaV2,
    schemaV3,
  };
}
