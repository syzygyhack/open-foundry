/**
 * OpenAPI 3.0 specification generator.
 *
 * Produces a JSON-serializable OpenAPI 3.0.3 document from the ParsedSchema.
 * Routes mirror the auto-generated REST layer (Section 8.2):
 *
 *   GET  /api/v1/{plural}               — list with filter + pagination
 *   GET  /api/v1/{plural}/aggregate     — field aggregations
 *   GET  /api/v1/{plural}/search        — full-text search
 *   GET  /api/v1/{plural}/:id           — get by ID
 *   GET  /api/v1/{plural}/:id/links/:linkType — linked objects
 *   GET  /api/v1/{plural}/:id/history   — version history
 *   POST /api/v1/actions/{ActionName}   — execute action
 */

import type { ParsedSchema, ObjectType, ActionType, FieldDefinition } from '@openfoundry/odl';

// ─── Helpers ───

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function pluralize(s: string): string {
  return lowerFirst(s) + 's';
}

function odlTypeToJsonSchema(typeName: string, nonNull: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = (() => {
    switch (typeName) {
      case 'ID': return { type: 'string', format: 'uuid' };
      case 'String': return { type: 'string' };
      case 'Int': return { type: 'integer' };
      case 'Float': return { type: 'number' };
      case 'Boolean': return { type: 'boolean' };
      case 'DateTime': return { type: 'string', format: 'date-time' };
      case 'Date': return { type: 'string', format: 'date' };
      case 'JSON': return { type: 'object' };
      default: return { type: 'string' }; // enum values, custom scalars
    }
  })();
  if (!nonNull) {
    return { ...base, nullable: true };
  }
  return base;
}

function isPrimary(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'primary');
}
function isComputed(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'computed');
}
function isLink(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'link');
}
function isParam(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'param');
}

// ─── Schema helpers ───

function objectSchema(obj: ObjectType): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of obj.fields) {
    if (isComputed(field) || isLink(field)) continue;
    const key = isPrimary(field) ? field.name : field.name;
    props[key] = odlTypeToJsonSchema(field.type.name, field.type.nonNull);
    if (field.type.nonNull) required.push(key);
  }
  // System fields
  props['_redactedFields'] = { type: 'array', items: { type: 'string' }, nullable: true };
  props['_consentRestricted'] = { type: 'boolean' };

  const schema: Record<string, unknown> = { type: 'object', properties: props };
  if (required.length > 0) schema['required'] = required;
  return schema;
}

function actionInputSchema(action: ActionType): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of action.fields) {
    if (!isParam(field)) continue;
    props[field.name] = odlTypeToJsonSchema(field.type.name, field.type.nonNull);
    if (field.type.nonNull) required.push(field.name);
  }
  const schema: Record<string, unknown> = { type: 'object', properties: props };
  if (required.length > 0) schema['required'] = required;
  return schema;
}

// ─── Path generators ───

function objectPaths(obj: ObjectType): Record<string, unknown> {
  const plural = pluralize(obj.name);
  const tag = obj.name;
  const ref = `#/components/schemas/${obj.name}`;
  const paths: Record<string, unknown> = {};

  // GET /api/v1/{plural}
  paths[`/api/v1/${plural}`] = {
    get: {
      tags: [tag],
      summary: `List ${obj.name} objects`,
      operationId: `list${obj.name}s`,
      parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 100 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        { name: 'sort', in: 'query', schema: { type: 'string' }, description: 'Sort field' },
        { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
        ...obj.fields
          .filter(f => !isPrimary(f) && !isComputed(f) && !isLink(f))
          .map(f => ({
            name: `filter[${f.name}]`,
            in: 'query' as const,
            schema: odlTypeToJsonSchema(f.type.name, false),
            description: `Filter by ${f.name}`,
          })),
      ],
      responses: {
        '200': {
          description: `List of ${obj.name} objects`,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: { type: 'array', items: { $ref: ref } },
                  pagination: { $ref: '#/components/schemas/Pagination' },
                },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '429': { $ref: '#/components/responses/RateLimited' },
      },
    },
  };

  // GET /api/v1/{plural}/aggregate
  paths[`/api/v1/${plural}/aggregate`] = {
    get: {
      tags: [tag],
      summary: `Aggregate ${obj.name} objects`,
      operationId: `aggregate${obj.name}s`,
      parameters: [
        { name: 'fields', in: 'query', required: true, schema: { type: 'string' }, description: 'Comma-separated field:function pairs (e.g. age:avg,salary:sum)' },
        { name: 'groupBy', in: 'query', schema: { type: 'string' }, description: 'Field to group by' },
      ],
      responses: {
        '200': { description: 'Aggregation result', content: { 'application/json': { schema: { type: 'object' } } } },
        '401': { $ref: '#/components/responses/Unauthorized' },
      },
    },
  };

  // GET /api/v1/{plural}/search
  paths[`/api/v1/${plural}/search`] = {
    get: {
      tags: [tag],
      summary: `Full-text search ${obj.name} objects`,
      operationId: `search${obj.name}s`,
      parameters: [
        { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query' },
        {
          name: 'fields', in: 'query', schema: { type: 'string' },
          description: 'Fields to search, comma-separated; the parameter may be repeated. '
            + 'Omitted or empty: the provider\'s default text fields, or, for a caller with field '
            + 'restrictions, that caller\'s visible String properties. Only separators (`,`) searches nothing. '
            + 'On PostgreSQL, a name that is not a text column of the type is a 400 VALIDATION_ERROR.',
        },
        {
          name: 'limit', in: 'query', schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
          description: 'Page size; 0 or a value that is not a number means the default, a larger value the maximum.',
        },
        { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 } },
      ],
      responses: {
        '200': {
          description: 'Search results, best match first',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { node: { $ref: ref }, score: { type: 'number' } },
                    },
                  },
                  pagination: { $ref: '#/components/schemas/Pagination' },
                },
              },
            },
          },
        },
        '400': { description: 'Missing q, or a field that cannot be searched' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '403': { description: 'A named field is redacted for the caller' },
      },
    },
  };

  // GET /api/v1/{plural}/{id}
  paths[`/api/v1/${plural}/{id}`] = {
    get: {
      tags: [tag],
      summary: `Get ${obj.name} by ID`,
      operationId: `get${obj.name}`,
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: `${obj.name} object`,
          content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: ref } } } } },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '404': { description: 'Not found' },
      },
    },
  };

  // GET /api/v1/{plural}/{id}/links/{linkType}
  paths[`/api/v1/${plural}/{id}/links/{linkType}`] = {
    get: {
      tags: [tag],
      summary: `Get linked objects from ${obj.name}`,
      operationId: `get${obj.name}Links`,
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'linkType', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 25 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
      ],
      responses: {
        '200': { description: 'Linked objects', content: { 'application/json': { schema: { type: 'object' } } } },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '404': { description: 'Not found' },
      },
    },
  };

  // GET /api/v1/{plural}/{id}/history
  paths[`/api/v1/${plural}/{id}/history`] = {
    get: {
      tags: [tag],
      summary: `Get version history of ${obj.name}`,
      operationId: `get${obj.name}History`,
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': { description: 'Version history', content: { 'application/json': { schema: { type: 'object' } } } },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '404': { description: 'Not found' },
      },
    },
  };

  return paths;
}

function actionPath(action: ActionType): Record<string, unknown> {
  return {
    [`/api/v1/actions/${action.name}`]: {
      post: {
        tags: ['Actions'],
        summary: `Execute ${action.name}`,
        operationId: `execute${action.name}`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: actionInputSchema(action),
            },
          },
        },
        responses: {
          '200': {
            description: 'Action result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean' },
                    data: { type: 'object' },
                    warnings: { type: 'array', items: { type: 'object' }, nullable: true },
                  },
                },
              },
            },
          },
          '400': { description: 'Validation error or precondition failed' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
  };
}

/**
 * Governance paths that are not derived from the ODL schema — the care-team
 * relationship grant/revoke API (v0.2.0 A1) and the consent-record API (A2).
 * Mounted unconditionally in server.ts; documented here so client generation and
 * contract checks see the full REST surface.
 */
function governancePaths(): Record<string, unknown> {
  const errorContent = { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } };
  const relationshipBody = {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['user', 'relation', 'objectType', 'objectId'],
          properties: {
            user: { type: 'string', description: 'Subject user id (bare or `user:<id>`).' },
            relation: { type: 'string', description: 'A directly-grantable `[user]` relation from the merged FGA model.' },
            objectType: { type: 'string', description: 'Object type (e.g. Patient, Ward).' },
            objectId: { type: 'string' },
          },
        },
      },
    },
  };
  return {
    '/api/v1/relationships': {
      post: {
        tags: ['Governance'],
        summary: 'Grant a directly-assignable ReBAC relationship (care-team)',
        operationId: 'grantRelationship',
        requestBody: relationshipBody,
        responses: {
          '200': { description: 'Relationship granted' },
          '400': { description: 'Invalid/non-grantable relation or missing field', content: errorContent },
          '403': { description: 'Caller lacks a granter role', content: errorContent },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
      delete: {
        tags: ['Governance'],
        summary: 'Revoke a directly-assignable ReBAC relationship',
        operationId: 'revokeRelationship',
        requestBody: relationshipBody,
        responses: {
          '200': { description: 'Relationship revoked' },
          '400': { description: 'Invalid/non-grantable relation or missing field', content: errorContent },
          '403': { description: 'Caller lacks a granter role', content: errorContent },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/api/v1/consent': {
      post: {
        tags: ['Governance'],
        summary: 'Record a consent decision for a data subject',
        operationId: 'recordConsent',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['subject'],
                properties: {
                  subject: { type: 'string', description: 'Consent subject id.' },
                  purpose: { type: 'string', description: 'A DataPurpose from the deployment vocabulary (CONSENT_PURPOSES); default DEFAULT_CONSENT_PURPOSE.' },
                  decision: { type: 'string', enum: ['GRANT', 'DENY'], default: 'GRANT' },
                  evidence: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Consent recorded' },
          '400': { description: 'Validation error (unknown purpose / invalid decision / missing subject)', content: errorContent },
          '403': { description: 'Caller lacks a consent-recorder role', content: errorContent },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
  };
}

// ─── Public API ───

/**
 * Generate an OpenAPI 3.0.3 specification from a ParsedSchema.
 *
 * @param version - Spec version string (defaults to '1.0.0').
 *                  Dump CLIs pass the platform version from package.json.
 */
export function generateOpenApiSpec(schema: ParsedSchema, version = '1.0.0'): Record<string, unknown> {
  // Merge all paths
  let paths: Record<string, unknown> = {};
  for (const obj of schema.objectTypes) {
    paths = { ...paths, ...objectPaths(obj) };
  }
  for (const action of schema.actionTypes) {
    paths = { ...paths, ...actionPath(action) };
  }
  // Governance APIs (A1 relationships, A2 consent) — not ODL-derived.
  paths = { ...paths, ...governancePaths() };

  // Component schemas
  const schemas: Record<string, unknown> = {};
  for (const obj of schema.objectTypes) {
    schemas[obj.name] = objectSchema(obj);
  }

  // Enum schemas
  for (const e of schema.enums) {
    schemas[e.name] = {
      type: 'string',
      enum: e.values.map(v => v.name),
    };
  }

  // Shared schemas
  schemas['Pagination'] = {
    type: 'object',
    // As the list, search and link routes return it.
    properties: {
      totalCount: { type: 'integer', description: 'Matching objects across all pages' },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
      hasNextPage: { type: 'boolean' },
      hasPreviousPage: { type: 'boolean' },
    },
    required: ['totalCount', 'limit', 'offset', 'hasNextPage', 'hasPreviousPage'],
  };
  schemas['ErrorResponse'] = {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          category: { type: 'string' },
          message: { type: 'string' },
          retryable: { type: 'boolean' },
          details: { type: 'object' },
          traceId: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    },
  };

  return {
    openapi: '3.0.3',
    info: {
      title: 'Open Foundry API',
      version,
      description: 'Auto-generated REST API for the Open Foundry ontology platform.',
      license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
    },
    servers: [
      { url: '/', description: 'Current server' },
    ],
    paths,
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      responses: {
        Unauthorized: {
          description: 'Authentication required',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        RateLimited: {
          description: 'Rate limit exceeded',
          headers: {
            'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until the rate limit resets' },
          },
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  };
}
