/**
 * Server entrypoint — starts the Open Foundry API gateway.
 *
 * Mounts GraphQL, REST, and FHIR endpoints on a single Express server.
 * Used by the Dockerfile CMD and for local development.
 *
 * Configuration via environment variables:
 *   PORT                 — HTTP port (default: 4000)
 *   NODE_ENV             — 'production' enables real service wiring
 *   DOMAIN_PACKS_DIR     — Path to domain-packs directory (auto-detected if omitted)
 *   DOMAIN_PACKS         — Comma-separated or JSON array of pack names to load
 *   OIDC_ISSUER          — OIDC provider issuer URL (matches Helm configmap)
 *   OIDC_CLIENT_ID       — OIDC client ID
 *   OIDC_JWKS_URI        — JWKS endpoint override for non-Keycloak issuers
 *   OIDC_DEFAULT_TENANT  — Opt-in fallback tenant for tokens without a tenant_id claim (unset = fail-closed)
 *   OPENFGA_URL          — OpenFGA API URL (matches Helm configmap / docker-compose)
 *   OPENFGA_STORE_ID     — OpenFGA store ID
 *   POSTGRES_URL         — PostgreSQL connection string (with ?sslmode= for TLS)
 *   CEL_EVALUATOR_URL    — CEL gRPC sidecar address (default: localhost:50051)
 *   CORS_ALLOWED_ORIGINS — Comma-separated allowed origins (empty = deny all in prod)
 *   FHIR_BASE_URL        — Externally routable FHIR base URL for Bundle links
 *   REDPANDA_BROKERS     — Comma-separated Kafka/Redpanda brokers (enables persistent events)
 *   REDIS_URL            — Redis connection URL (enables distributed rate limiting)
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { GraphQLError } from 'graphql';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { MemoryStorageProvider } from '@openfoundry/storage-memory';
import { PostgresStorageProvider, PostgresAuditStore, PostgresConsentStore, PostgresSchemaRegistry, PostgresObjectSetStore } from '@openfoundry/storage-postgres';
import {
  ObjectManager,
  LinkManager,
  EngineEventEmitter,
  InMemoryObjectSetStore,
  ObjectSetManager,
} from '@openfoundry/engine';
import { ActionExecutor, CelClient, SideEffectExecutor } from '@openfoundry/actions';
import type { SecurityLayer, CelEvaluator, ActionEventPublisher, EventBus as SideEffectEventBus, HttpClient as SideEffectHttpClient, LinkTupleMap } from '@openfoundry/actions';
import { AuthorizationService, OidcAuthenticator, AuditWriter, MemoryAuditStore, ConsentService, MemoryConsentStore } from '@openfoundry/security';
import type { OpenFgaClientInterface } from '@openfoundry/security';
import type { StorageProvider, RequestContext } from '@openfoundry/spi';
import { createGraphQLServer, buildResolverContext } from './graphql/index.js';
import { generateRestRoutes, generateOpenApiSpec } from './rest/index.js';
import { readPlatformVersion } from './version.js';
import { createFhirRouter } from './fhir/index.js';
import { createCdmRouter } from './cdm/index.js';
import { generateRelationshipRoutes, buildGrantAllowlist } from './relationships/router.js';
import { generateConsentRoutes, assertConsentConfig } from './consent/router.js';
import { InMemorySubscribableEventBus, SubscriptionManager } from './subscriptions/index.js';
import type { SubscribableEventBus } from './subscriptions/index.js';
import { RedpandaEventBus } from './events/index.js';
import type { ApiDependencies, ResolverContext } from './graphql/types.js';
import { DEFAULT_CONSENT_PURPOSE } from './graphql/types.js';
import type { RestRequest } from './rest/types.js';
import {
  parsePostgresUrl,
  createFgaClient,
  createSecurityLayer,
  extractUser,
  REQUIRED_PROD_VARS,
} from './config.js';
import type { ActionAuthzMapping } from './config.js';
import { loadDomainPacks } from './schema-loader.js';
import { generateOpenFGASchema, mergeOpenFGAOverrides, InMemorySchemaRegistry } from '@openfoundry/odl';
import type { SchemaRegistry } from '@openfoundry/odl';
import { recordSchemaVersion } from './schema-registry-boot.js';
import { SlidingWindowRateLimiter, RedisRateLimiter } from './governance/index.js';
import type { RateLimiter, RateLimitIdentity } from './governance/index.js';
import { toSnakeCase } from './utils.js';
import { metricsMiddleware, metricsEndpoint, startStorageHealthGauge, packLoaded } from './metrics.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env['PORT'] ?? '4000', 10);

/**
 * Parse DOMAIN_PACKS env var which may be:
 *   - Comma-separated names: "nhs-acute,aml"
 *   - JSON array of objects from Helm: [{"name":"nhs-acute","version":"0.2.0"}]
 *   - undefined (returns undefined → auto-discover)
 */
function parseDomainPacksEnv(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item: unknown) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object' && 'name' in item) return String((item as { name: unknown }).name);
            return '';
          })
          .filter(Boolean);
      }
    } catch {
      // Fall through to comma-split
    }
  }
  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const isDev = process.env['NODE_ENV'] !== 'production';

  // ── OpenTelemetry ──
  // Must be initialized before significant work starts so the global
  // TracerProvider is registered for all getTracer()/withSpan() calls.
  const { initTelemetry } = await import('@openfoundry/observability');
  initTelemetry('openfoundry-api');

  // ── Validate production environment ──
  if (!isDev) {
    const missing = REQUIRED_PROD_VARS.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      logger.error(`FATAL: Production mode requires env vars: ${missing.join(', ')}`);
      process.exit(1);
    }
  }

  // ── Rate Limiter ──
  // REDIS_URL → distributed rate limiting across pods; otherwise in-memory per-pod.
  let rateLimiter: RateLimiter;
  let redisClient: import('ioredis').Redis | undefined;
  const redisUrl = process.env['REDIS_URL'];
  if (redisUrl) {
    // Dynamic import for optional dependency — cast needed for CJS/ESM interop
    const ioredis = await import('ioredis');
    const RedisClient = ioredis.default as unknown as new (url: string, opts: Record<string, unknown>) => import('ioredis').Redis;
    redisClient = new RedisClient(redisUrl, {
      // Fail fast: rate limiting is QoS, not a security boundary.
      // Default ioredis retries 20 times with offline queue, stalling requests for seconds.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3_000,
      commandTimeout: 1_000,
    });
    rateLimiter = new RedisRateLimiter(redisClient);
    logger.info(`Rate limiter: Redis @ ${redisUrl.replace(/\/\/.*@/, '//<redacted>@')}`);
  } else {
    rateLimiter = new SlidingWindowRateLimiter();
    if (!isDev) {
      logger.warn('WARNING: Rate limiter is in-memory — limits are per-pod. Set REDIS_URL for distributed rate limiting.');
    }
  }

  // ── Storage ──
  // Use PostgreSQL when POSTGRES_URL is set, even in development mode.
  // This allows local Docker Compose setups to use persistent storage.
  let storage: StorageProvider;
  if (process.env['POSTGRES_URL']) {
    const config = parsePostgresUrl(process.env['POSTGRES_URL']);
    storage = new PostgresStorageProvider(config);
    logger.info(`Storage: PostgreSQL @ ${config.host}:${config.port}/${config.database}`);
  } else {
    storage = new MemoryStorageProvider();
    if (isDev) {
      logger.warn('Storage: in-memory (development mode)');
    }
  }

  // ── Schema (load from domain packs) ──
  // DOMAIN_PACKS may be comma-separated names ("nhs-acute,aml") or JSON from Helm
  // ([{"name":"nhs-acute","version":"0.2.0"}]). Handle both formats.
  const packNames = parseDomainPacksEnv(process.env['DOMAIN_PACKS']);
  const {
    parsed: schema, spiSchema, packs, packInfos, manifestRegistry,
    fieldPermissions, permissionOverrides, connectorManifests, seedManifests,
  } = await loadDomainPacks(undefined, packNames);
  logger.info(
    `Schema: loaded ${packs.length} domain pack(s) — ` +
    `${schema.objectTypes.length} object types, ` +
    `${schema.linkTypes.length} link types, ` +
    `${schema.enums.length} enums`,
  );
  if (permissionOverrides.length > 0) {
    logger.info(`Schema: ${permissionOverrides.length} OpenFGA permission override(s) from domain packs`);
  }
  if (connectorManifests.length > 0) {
    logger.info(`Schema: ${connectorManifests.length} connector manifest(s) from domain packs`);
  }
  if (seedManifests.length > 0) {
    const totalSeedObjects = seedManifests.reduce((n, s) => n + s.objects.length, 0);
    const totalSeedLinks = seedManifests.reduce((n, s) => n + s.links.length, 0);
    logger.info(`Schema: ${seedManifests.length} seed manifest(s) — ${totalSeedObjects} object(s) + ${totalSeedLinks} link(s)`);
  }
  if (schema.objectTypes.length === 0) {
    logger.warn('WARNING: No object types loaded — check DOMAIN_PACKS configuration.');
  }

  // Apply schema to storage (creates tables/indexes in Postgres, registers types in memory)
  const bootCtx: RequestContext = { tenantId: 'system', actorId: 'boot' };
  await storage.applySchema(bootCtx, spiSchema);

  // Tenant for bootstrap seed data. Defaults to 'system' (isolated from ordinary
  // request tenants); set SEED_TENANT to the request tenant (e.g. 'default') when
  // seeded reference data must be readable through the API — otherwise seeds are
  // invisible to API reads in a different tenant.
  const seedCtx: RequestContext = {
    tenantId: process.env['SEED_TENANT'] ?? 'system',
    actorId: 'boot',
  };

  // ── Schema registry (versioned ODL schema history) ──
  // Records the merged ParsedSchema as a new version when it differs from the
  // latest stored one. PostgreSQL-backed when available (durable, shared across
  // pods); in-memory otherwise. Recording is non-blocking and auto-approves the
  // migration plan: a breaking pack change is *recorded* (with a warning) rather
  // than blocking startup — enforcement of breaking changes is a governance-time
  // concern (a future schema-management API), not a boot gate.
  const schemaRegistry: SchemaRegistry = storage instanceof PostgresStorageProvider
    ? new PostgresSchemaRegistry(storage.pool)
    : new InMemorySchemaRegistry();
  try {
    const result = await recordSchemaVersion(schemaRegistry, schema);
    if (result.breaking) {
      logger.warn('Schema registry: BREAKING schema change detected at boot — recorded under an auto-approved migration plan. Review schema history before promoting.');
    }
    if (result.recorded) {
      const backend = storage instanceof PostgresStorageProvider ? 'PostgreSQL' : 'in-memory';
      logger.info(`Schema registry: recorded schema version ${result.version} (${backend})`);
    }
  } catch (err) {
    // Non-fatal: schema-history recording must not block startup.
    logger.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'Schema registry: failed to record schema version');
  }

  // ── Register loaded packs in _domain_packs table (Postgres only) ──
  if (storage instanceof PostgresStorageProvider) {
    try {
      for (const info of packInfos) {
        await storage.pool.query(
          `INSERT INTO _domain_packs (name, version, namespace)
           VALUES ($1, $2, $3)
           ON CONFLICT (name) DO UPDATE SET version = EXCLUDED.version, loaded_at = NOW()`,
          [info.manifest.name, info.manifest.version, info.manifest.namespace],
        );
      }
      logger.info(`Domain packs: registered ${packInfos.length} pack(s) in _domain_packs`);
    } catch (err) {
      // Non-fatal: table may not exist yet (init-services.sh creates it)
      logger.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'Domain packs: failed to register in _domain_packs (table may not exist yet)');
    }
  }

  // ── Engine ──
  // REDPANDA_BROKERS → persistent event streaming via Kafka protocol;
  // otherwise in-memory (events lost on restart).
  let eventBus: SubscribableEventBus;
  const redpandaBrokers = process.env['REDPANDA_BROKERS'];
  if (redpandaBrokers) {
    const rpBus = new RedpandaEventBus({
      brokers: redpandaBrokers.split(',').map(s => s.trim()),
    });
    await rpBus.connect();
    eventBus = rpBus;
    logger.info(`EventBus: Redpanda/Kafka @ ${redpandaBrokers}`);
  } else {
    eventBus = new InMemorySubscribableEventBus();
    if (!isDev) {
      logger.warn('WARNING: EventBus is in-memory — events will not survive restarts. Set REDPANDA_BROKERS to enable persistent streaming.');
    }
  }
  const emitter = new EngineEventEmitter(eventBus);
  const objectManager = new ObjectManager({ storage, schema, eventEmitter: emitter });
  const linkManager = new LinkManager({ storage, schema, eventEmitter: emitter });

  // ── Bootstrap Seeds ──
  // Apply seed data from domain packs (idempotent — skips objects that already exist).
  // Runs through ObjectManager/LinkManager for full validation, events, and audit.
  // Objects can declare a `ref` label; links reference objects by `ref` or literal ID.
  //
  // Seeded links bypass the action executor, so their ReBAC tuples aren't minted
  // by the pipeline. We capture the resolved (type, fromId, toId) here and mint
  // the matching tuples once the authz layer + linkTupleMap are available below —
  // keeping seeded links consistent with runtime-created ones.
  const seededLinkTuples: Array<{ type: string; fromId: string; toId: string }> = [];
  if (seedManifests.length > 0) {
    let seededObjects = 0;
    let seededLinks = 0;
    let skippedObjects = 0;
    // ref → generated _id, shared across all seeds for cross-pack references
    const refMap = new Map<string, string>();

    for (const seed of seedManifests) {
      // Phase 1: Create objects
      for (const obj of seed.objects) {
        // Idempotency: if this ref was seeded in a prior run, try to find it
        // by a unique field. For objects with a `name` field we use that as
        // the natural key. This is best-effort — packs with non-unique fields
        // will re-create on each boot (ObjectManager deduplication protects
        // unique-indexed fields from duplicates).
        const nameValue = obj.fields['name'] ?? obj.fields['title'];
        if (nameValue && typeof nameValue === 'string') {
          try {
            const results = await storage.queryObjects(seedCtx, obj.type,
              { field: 'name', operator: 'eq', value: nameValue },
              { limit: 1 },
            );
            if (results.items.length > 0) {
              const existingId = results.items[0]!._id;
              if (obj.ref) refMap.set(obj.ref, existingId);
              skippedObjects++;
              continue;
            }
          } catch {
            // Type may not support filter or field doesn't exist — proceed to create
          }
        }
        try {
          const created = await objectManager.create(obj.type, obj.fields, seedCtx);
          const createdId = created['_id'] as string;
          if (obj.ref) refMap.set(obj.ref, createdId);
          logger.info(`Seed: created ${obj.type} '${createdId}' (ref: ${obj.ref ?? 'none'}) from pack '${seed.packName}'`);
          seededObjects++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`Seed: failed to create ${obj.type} from pack '${seed.packName}': ${msg}`);
        }
      }

      // Phase 2: Create links (after all objects in this seed exist)
      for (const lnk of seed.links) {
        const fromId = refMap.get(lnk.from) ?? lnk.from;
        const toId = refMap.get(lnk.to) ?? lnk.to;
        // Record for tuple minting regardless of create/exists (writes are
        // idempotent), so re-boots backfill tuples for pre-existing seed links.
        seededLinkTuples.push({ type: lnk.type, fromId, toId });
        try {
          await linkManager.createLink(lnk.type, fromId, toId, lnk.fields, seedCtx);
          seededLinks++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Duplicate link is expected on re-run — don't warn loudly
          if (msg.includes('already exists') || msg.includes('duplicate') || msg.includes('cardinality')) {
            logger.info(`Seed: link ${lnk.type} ${fromId}→${toId} already exists, skipping`);
          } else {
            logger.warn(`Seed: failed to create link ${lnk.type} from pack '${seed.packName}': ${msg}`);
          }
        }
      }
    }

    if (seededObjects > 0 || seededLinks > 0 || skippedObjects > 0) {
      logger.info(`Seed: created ${seededObjects} object(s) + ${seededLinks} link(s), skipped ${skippedObjects} existing`);
    }
  }

  // ── Authentication ──
  const oidcIssuer = process.env['OIDC_ISSUER'] ?? 'http://localhost:8180/realms/openfoundry';
  const authenticator = new OidcAuthenticator();
  authenticator.configure({
    issuer: oidcIssuer,
    clientId: process.env['OIDC_CLIENT_ID'] ?? 'openfoundry',
    // OIDC_JWKS_URI overrides for non-Keycloak issuers (e.g. NHS CIS2).
    // Default: Keycloak-style path. Set OIDC_JWKS_URI for other providers.
    jwksUri: process.env['OIDC_JWKS_URI'] ?? `${oidcIssuer}/protocol/openid-connect/certs`,
    // Opt-in fallback tenant for IdP tokens that carry no `tenant_id` claim.
    // Unset (undefined) is normalized to null by configure(), preserving the
    // documented fail-closed posture (MISSING_TENANT -> 401). Single-tenant
    // deployments set OIDC_DEFAULT_TENANT=default; multi-tenant deployments leave
    // it unset and map real tenants via a tenant_id claim. See issue #1.
    defaultTenantId: process.env['OIDC_DEFAULT_TENANT'],
  });

  // ── Authorization (OpenFGA) ──
  let fgaClient: OpenFgaClientInterface;
  if (!isDev && process.env['OPENFGA_URL'] && process.env['OPENFGA_STORE_ID']) {
    fgaClient = await createFgaClient(
      process.env['OPENFGA_URL'],
      process.env['OPENFGA_STORE_ID'],
    );
    logger.info(`Authorization: OpenFGA @ ${process.env['OPENFGA_URL']}`);
  } else if (isDev) {
    // Dev stub: allow everything.
    // listObjects returns ['*'] sentinel — resolvers interpret this as
    // "all objects authorized" and skip the ID-based filter.
    fgaClient = {
      check: async () => ({ allowed: true }),
      listObjects: async () => ({ objects: ['*'] }),
      writeTuples: async () => ({}),
      deleteTuples: async () => ({}),
    };
    logger.warn('Authorization: allow-all stub (development mode)');
  } else {
    // Unreachable in normal operation: the REQUIRED_PROD_VARS guard above exits
    // the process if OPENFGA_URL/OPENFGA_STORE_ID are missing in production.
    // Defence in depth — fail closed rather than silently installing an
    // allow-all authorizer if that guard is ever weakened or bypassed.
    throw new Error(
      'FATAL: production authorization requires OPENFGA_URL and OPENFGA_STORE_ID',
    );
  }
  // Merged OpenFGA model (schema + pack permission overrides). Pure/cheap, so
  // computed unconditionally — the relationship grant API derives its allowlist
  // from it even in dev (where the OpenFGA client is the allow-all stub).
  const mergedFgaDsl = permissionOverrides.length > 0
    ? mergeOpenFGAOverrides(generateOpenFGASchema(schema), permissionOverrides)
    : generateOpenFGASchema(schema);
  const fgaModelJson = fgaDslToJson(mergedFgaDsl);
  // Allowlist of directly-grantable [user] relations (e.g. patient.clinician,
  // ward.assigned) for the /api/v1/relationships grant API (Epic A1).
  const grantAllowlist = buildGrantAllowlist(fgaModelJson);

  // Deployment policy: which platform roles may grant relationships / record
  // consent. Generic default is `admin` only; an NHS deployment broadens these
  // via env (e.g. RELATIONSHIP_GRANTER_ROLES=admin,nurse_in_charge) rather than
  // forcing clinical role names on every deployment.
  const parseRoles = (v: string | undefined): string[] | undefined => {
    const roles = (v ?? '').split(',').map(r => r.trim()).filter(Boolean);
    return roles.length > 0 ? roles : undefined;
  };
  const granterRoles = parseRoles(process.env['RELATIONSHIP_GRANTER_ROLES']) ?? ['admin'];
  const consentRecorderRoles = parseRoles(process.env['CONSENT_RECORDER_ROLES']) ?? ['admin'];

  // Deployment-defined consent-purpose vocabulary (env CONSENT_PURPOSES). Unset →
  // the consent router falls back to the standard NHS/UK-IG preset (back-compat).
  // `DataPurpose` is an open string type, so a non-NHS deployment can define e.g.
  // CONSENT_PURPOSES=KYC,AML_MONITORING. Warn if the default purpose used for
  // read access checks is outside the configured vocabulary.
  const consentPurposes = parseRoles(process.env['CONSENT_PURPOSES']);
  // Object types whose @param marks an action's consent subject (env
  // CONSENT_SUBJECT_TYPES). Unset → ['Patient'] (back-compat); a non-NHS
  // deployment sets its own subject type(s), e.g. Customer.
  const consentSubjectTypes = parseRoles(process.env['CONSENT_SUBJECT_TYPES']);
  const exemptionEnabled = process.env['CONSENT_DIRECT_CARE_EXEMPTION'] === 'true';

  // Fail fast on impossible/ambiguous consent configuration rather than booting
  // into a state operators cannot fix through the API.
  assertConsentConfig({
    consentPurposes,
    defaultPurpose: DEFAULT_CONSENT_PURPOSE,
    exemptionEnabled,
    consentSubjectTypes,
  });

  // Capability-gated facades. The FHIR (/fhir/*) and FDP/CDM (REST /api/v1/cdm/*
  // + the GraphQL cdm* queries) surfaces are NHS-shaped and only enabled when a
  // loaded pack opts in via `capabilities:` in pack.yaml. Computed before the
  // GraphQL schema is built so the SDL, resolvers, and REST mount stay in lockstep.
  const packCapabilities = new Set(packs.flatMap(p => p.capabilities ?? []));
  const cdmEnabled = packCapabilities.has('cdm');
  const fhirEnabled = packCapabilities.has('fhir');
  logger.info(`Capabilities: cdm=${cdmEnabled} fhir=${fhirEnabled} (declared by loaded packs)`);

  // ── OpenFGA Authorization Model Sync ──
  // Push the merged model to OpenFGA so all pack types are authorized.
  let linkTupleMap: LinkTupleMap | undefined;
  if (!isDev && process.env['OPENFGA_URL'] && process.env['OPENFGA_STORE_ID']) {
    try {
      const modelJson = fgaModelJson;
      // Derive which ontology links map to ReBAC tuples, so the action pipeline
      // can mint them on link create/delete (only links whose snake(linkType)
      // relation exists in the merged model are synced).
      linkTupleMap = buildLinkTupleMap(schema, modelJson);
      if (linkTupleMap.size > 0) {
        logger.info(`Authorization: ${linkTupleMap.size} link type(s) sync ReBAC tuples (${[...linkTupleMap.keys()].join(', ')})`);
      }
      const storeId = process.env['OPENFGA_STORE_ID'];
      const fgaUrl = process.env['OPENFGA_URL'];
      const resp = await fetch(
        `${fgaUrl}/stores/${storeId}/authorization-models`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(modelJson),
        },
      );
      if (resp.ok) {
        logger.info(`Authorization: OpenFGA model synced (${modelJson.type_definitions.length} types)`);
      } else {
        const body = await resp.text();
        logger.warn(`Authorization: OpenFGA model sync failed (${resp.status}): ${body}`);
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'Authorization: OpenFGA model sync failed');
    }
  }

  const authorizationService = new AuthorizationService(fgaClient, fieldPermissions);

  // ── Backfill ReBAC tuples for seeded links ──
  // Seeded links bypass the action executor (which mints tuples at runtime), so
  // mint their tuples here now that the model + authz layer are ready. Mirrors
  // the executor's syncLinkTuple. Prod-only (linkTupleMap is built from the
  // merged FGA model); idempotent; best-effort.
  if (linkTupleMap && linkTupleMap.size > 0 && seededLinkTuples.length > 0) {
    let minted = 0;
    for (const l of seededLinkTuples) {
      const m = linkTupleMap.get(l.type);
      if (!m || !l.fromId || !l.toId) continue;
      try {
        await authorizationService.writeRelationship(`${m.toType}:${l.toId}`, m.relation, `${m.fromType}:${l.fromId}`);
        minted++;
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : 'unknown', linkType: l.type }, 'Seed: failed to mint ReBAC tuple');
      }
    }
    if (minted > 0) logger.info(`Seed: minted ${minted} ReBAC tuple(s) for seeded links`);
  }

  // ── CEL Evaluator ──
  let cel: CelEvaluator;
  const celAddress = (process.env['CEL_EVALUATOR_URL'] ?? 'localhost:50051')
    .replace(/^grpc:\/\//, '');
  if (!isDev || process.env['CEL_EVALUATOR_URL']) {
    cel = new CelClient({ address: celAddress });
    logger.info(`CEL evaluator: gRPC @ ${celAddress}`);
  } else {
    // Dev stub: always evaluate to true
    cel = { async evaluate() { return { value: true }; } };
    logger.warn('CEL evaluator: allow-all stub (development mode)');
  }

  // ── Security Layer (for action pipeline) ──
  // Derive action-to-FGA mappings from schema actionTypes.
  // E.g., AdmitPatient → check can_admit on patient:<id>
  const actionMappings = deriveActionAuthzMappings(schema);
  let security: SecurityLayer;
  if (!isDev) {
    security = createSecurityLayer(authorizationService, actionMappings);
  } else {
    security = { async checkPermission() { return { allowed: true }; } };
  }

  // ── Audit Trail ──
  const auditStore = (storage instanceof PostgresStorageProvider)
    ? new PostgresAuditStore(storage.pool)
    : new MemoryAuditStore();
  const securityAuditWriter = new AuditWriter(auditStore);
  // Adapt return type: security AuditWriter returns AuditRecord, action pipeline expects void
  const auditWriter = { async write(record: Parameters<typeof securityAuditWriter.write>[0]) { await securityAuditWriter.write(record); } };
  if (storage instanceof PostgresStorageProvider) {
    logger.info('Audit: PostgreSQL (persistent)');
  } else {
    logger.warn('Audit: in-memory (development mode)');
  }

  // ── Consent Service (Section 7.3) ──
  // PostgresConsentStore accepts a constructor-level default tenantId but all
  // methods also accept per-call tenantId, threaded from RequestContext by each
  // API layer (GraphQL, REST, FHIR, Actions).
  const consentStore = (storage instanceof PostgresStorageProvider)
    ? new PostgresConsentStore(storage.pool)
    : new MemoryConsentStore();
  // Legitimate-relationship consent exemption (NHS s251 is the reference case).
  // Generic default OFF — a deployment opts in via CONSENT_DIRECT_CARE_EXEMPTION
  // and may set the purpose it applies to (CONSENT_EXEMPTION_PURPOSE, default
  // DIRECT_CARE). The NHS reference stack enables it (see docker-compose).
  // (exemptionEnabled + the impossible-config guards are resolved above.)
  // FGA subject-type prefix for the exemption ReBAC check (bare subject id →
  // `${type}:${id}`). Derived from the configured action consent-subject type so
  // a non-NHS deployment (CONSENT_SUBJECT_TYPES=Customer) checks `customer:<id>`,
  // not `patient:<id>`. Single entry (validated above); snake-cased; unset →
  // ConsentService default 'patient'.
  const exemptionSubjectType = consentSubjectTypes && consentSubjectTypes.length > 0
    ? toSnakeCase(consentSubjectTypes[0]!)
    : undefined;
  const consentService = new ConsentService(consentStore, authorizationService, {
    directCareExemptionEnabled: exemptionEnabled,
    ...(process.env['CONSENT_EXEMPTION_PURPOSE']
      ? { exemptionPurpose: process.env['CONSENT_EXEMPTION_PURPOSE'] }
      : {}),
    ...(exemptionSubjectType ? { subjectType: exemptionSubjectType } : {}),
  });
  logger.info(`Consent: relationship-exemption ${exemptionEnabled ? 'enabled' : 'disabled'}`);
  if (storage instanceof PostgresStorageProvider) {
    logger.info('Consent: PostgreSQL (persistent)');
  } else {
    logger.warn('Consent: in-memory (development mode)');
  }

  // ── Action Executor ──
  // Bridge the engine event bus to the action event publisher interface
  const actionEventPublisher: ActionEventPublisher = {
    async publishObjectChange(changeType, objectType, objectId, _before, _after, cause, ctx) {
      const version = 1; // Actions don't track version; use placeholder
      const eventCause = { actionType: cause.actionType, actionId: cause.actionId, actor: cause.actor };
      if (changeType === 'created') await emitter.emitObjectCreated(ctx, objectType, objectId, version, eventCause);
      else if (changeType === 'updated') await emitter.emitObjectUpdated(ctx, objectType, objectId, version, {}, eventCause);
      else if (changeType === 'deleted') await emitter.emitObjectDeleted(ctx, objectType, objectId, version, eventCause);
    },
    async publishLinkChange(changeType, linkType, linkId, fromId, toId, cause, ctx) {
      const eventCause = { actionType: cause.actionType, actionId: cause.actionId, actor: cause.actor };
      if (changeType === 'created') await emitter.emitLinkCreated(ctx, linkType, linkId, fromId, toId, 1, eventCause);
      else if (changeType === 'deleted') await emitter.emitLinkDeleted(ctx, linkType, linkId, fromId, toId, 1, eventCause);
    },
  };
  // ── Side-effect handler (webhooks + CloudEvents after action commit) ──
  const sideEffectHttpClient: SideEffectHttpClient = {
    async post(url, body, options) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 10_000);
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...options?.headers },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        return { status: resp.status };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
  const sideEffectBus: SideEffectEventBus = {
    async emit(event) {
      await eventBus.publish(event as unknown as import('@openfoundry/spi').CloudEvent);
    },
  };
  const sideEffectHandler = new SideEffectExecutor({
    httpClient: sideEffectHttpClient,
    eventBus: sideEffectBus,
  });

  const actionExecutor = new ActionExecutor({
    storage, security, cel, auditWriter,
    eventPublisher: actionEventPublisher,
    consentManager: consentService,
    sideEffectHandler,
    // Mint graph-derived ReBAC tuples from link effects (prod only; map is
    // built from the merged OpenFGA model above).
    relationshipWriter: authorizationService,
    linkTupleMap,
  });

  // ── Object Sets ──
  // Persistent (durable across restarts, shared across pods) when backed by
  // PostgreSQL; in-memory otherwise.
  const objectSetStore = (storage instanceof PostgresStorageProvider)
    ? new PostgresObjectSetStore(storage.pool)
    : new InMemoryObjectSetStore();
  const objectSetManager = new ObjectSetManager(objectSetStore, objectManager);

  // ── Connector Registry ──
  // Create the default registry (jdbc + rest built-in), then validate that
  // all pack-declared connectors reference a registered plugin type.
  const { createDefaultRegistry } = await import('@openfoundry/sync');
  const connectorRegistry = createDefaultRegistry();
  for (const cm of connectorManifests) {
    if (connectorRegistry.has(cm.connector)) {
      logger.info(`Connector: '${cm.config['datasource'] ?? cm.connector}' (${cm.connector}) from pack '${cm.packName}'`);
    } else {
      logger.warn(`Connector: unknown type '${cm.connector}' in pack '${cm.packName}', skipping`);
    }
  }

  // ── API Dependencies ──
  const deps: ApiDependencies = {
    schema,
    objectManager,
    linkManager,
    actionExecutor,
    authorizationService,
    authenticator,
    consentService,
    storage,
    manifestRegistry,
    objectSetManager,
    auditWriter: securityAuditWriter,
    grantAllowlist,
    granterRoles,
    consentRecorderRoles,
    consentPurposes,
    ...(consentSubjectTypes ? { consentSubjectTypes } : {}),
    cdmEnabled,
  };

  // ── Express + HTTP Server ──
  const app = express();

  // Trust proxy headers (X-Forwarded-For) when behind ingress/load balancer.
  // Required for req.ip to reflect the real client IP, not the proxy IP.
  // In production, Kubernetes ingress terminates TLS and forwards traffic.
  if (!isDev) {
    app.set('trust proxy', 1); // trust first hop (ingress controller)
  }

  const httpServer = http.createServer(app);

  // ── GraphQL (Apollo Server + WebSocket Subscriptions) ──
  // Single executable schema shared by both Apollo (HTTP) and graphql-ws (WS)
  // transports. This guarantees mutations and subscriptions use the same PubSub.
  const { server: apolloServer, pubsub, executableSchema } = createGraphQLServer({ schema, deps, isDev });

  // WebSocket server for GraphQL subscriptions (graphql-ws protocol)
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: '/graphql',
    maxPayload: 64 * 1024, // 64 KB — GraphQL subscription payloads are small
  });
  const subscriptionManager = new SubscriptionManager({
    pubsub,
    eventBus,
    authenticate: async (connectionParams) => {
      const token = connectionParams?.['Authorization'] ?? connectionParams?.['authorization'];
      if (!token || typeof token !== 'string') {
        // Dev mode is allow-all: HTTP requests without a bearer token get a
        // synthetic dev user (extractUser). Mirror that for WebSocket
        // subscriptions so the dev experience is consistent — otherwise
        // subscriptions fail closed (the change-event filters require a user)
        // even though every other surface is open. Production still requires a
        // token (fail closed below).
        if (isDev) {
          const user = await extractUser({ headers: {} } as import('express').Request, authenticator, isDev);
          return { authenticated: true, user };
        }
        return { authenticated: false, error: 'Missing Authorization in connection params' };
      }
      try {
        const user = await extractUser(
          { headers: { authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` } } as import('express').Request,
          authenticator,
          isDev,
        );
        return { authenticated: true, user };
      } catch {
        return { authenticated: false, error: 'Invalid token' };
      }
    },
  });

  // Per-connection subscription tracking — prevents subscription-flood DoS.
  const MAX_SUBSCRIPTIONS_PER_CONNECTION = 50;
  const subscriptionCounts = new WeakMap<object, number>();

  const wsCleanup = useServer(
    {
      schema: executableSchema,
      context: async (ctx) => {
        const params = (ctx.connectionParams ?? {}) as Record<string, unknown>;
        const authResult = await subscriptionManager.authenticateConnection(params);
        if (!authResult.authenticated) {
          throw new Error(authResult.error);
        }
        return buildResolverContext(authResult.user, deps);
      },
      onSubscribe: (ctx) => {
        const key = (ctx as { extra?: object }).extra ?? ctx;
        const count = subscriptionCounts.get(key) ?? 0;
        if (count >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
          return [new GraphQLError('Subscription limit exceeded', {
            extensions: { code: 'RATE_LIMITED' },
          })];
        }
        subscriptionCounts.set(key, count + 1);
        return undefined; // proceed normally
      },
      onComplete: (ctx) => {
        const key = (ctx as { extra?: object }).extra ?? ctx;
        const count = subscriptionCounts.get(key) ?? 1;
        subscriptionCounts.set(key, Math.max(0, count - 1));
      },
    },
    wsServer as never,
  );

  subscriptionManager.start();

  apolloServer.addPlugin(ApolloServerPluginDrainHttpServer({ httpServer }) as never);
  apolloServer.addPlugin({
    async serverWillStart() {
      return {
        async drainServer() {
          subscriptionManager.stop();
          await wsCleanup.dispose();
        },
      };
    },
  });
  await apolloServer.start();

  // Security headers (disable CSP for GraphQL playground in dev)
  app.use(helmet({ contentSecurityPolicy: isDev ? false : undefined }));

  // CORS: restrict origins in production (fail-closed), allow-all in dev
  const corsOrigins = process.env['CORS_ALLOWED_ORIGINS']?.split(',').map(s => s.trim()).filter(Boolean);
  if (!isDev && (!corsOrigins || corsOrigins.length === 0)) {
    // Production: deny all cross-origin requests when not configured
    logger.warn('WARNING: CORS_ALLOWED_ORIGINS not set — all cross-origin requests will be denied. Set CORS_ALLOWED_ORIGINS if a frontend needs API access.');
    app.use(cors({ origin: false }));
  } else if (!isDev) {
    app.use(cors({ origin: corsOrigins, credentials: true }));
  } else {
    app.use(cors());
  }

  app.use(express.json({ limit: '1mb' }));

  // Pre-auth IP-based rate limiter: protects against unauthenticated floods
  // (auth+JWKS work is expensive; this gate runs before identity extraction)
  // Only per-IP (principal) limiting — no global tenant cap for unauthenticated traffic.
  // Explicit undefined suppresses defaults from shallow merge in both limiter constructors.
  const ipLimiterConfig = { tenant: undefined, principal: { windowMs: 60_000, maxRequests: 300 }, clientApp: undefined };
  const ipRateLimiter: RateLimiter = redisClient
    ? new RedisRateLimiter(redisClient, { config: ipLimiterConfig, keyPrefix: 'rl:ip:' })
    : new SlidingWindowRateLimiter(ipLimiterConfig);
  app.use(async (req, res, next) => {
    try {
      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      const result = await ipRateLimiter.check({ tenantId: 'global', principalId: ip });
      if (!result.allowed) {
        res.setHeader('Retry-After', String(Math.ceil((result.resetAt - Date.now()) / 1000)));
        res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests', retryable: true } });
        return;
      }
    } catch (err) {
      // Fail open: rate limiter error should not block requests
      logger.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'IP rate limiter error, failing open');
    }
    next();
  });

  // ── Prometheus metrics ──
  app.use(metricsMiddleware);
  // Block external access to /metrics — Prometheus ServiceMonitor scrapes pod
  // directly (bypassing ingress). Requests through ingress carry X-Forwarded-For.
  app.get('/metrics', (req, res, next) => {
    if (!isDev && req.headers['x-forwarded-for']) {
      res.status(404).end();
      return;
    }
    next();
  }, metricsEndpoint);
  const stopHealthGauge = startStorageHealthGauge(storage);

  // ── Health check ──
  // /health — used by readiness probe; returns 503 when storage is degraded
  app.get('/health', async (_req, res) => {
    try {
      const storageHealth = await storage.healthCheck();
      const status = storageHealth.healthy ? 'ok' : 'degraded';
      const httpStatus = storageHealth.healthy ? 200 : 503;
      res.status(httpStatus).json({
        status,
        service: 'api-gateway',
        storage: { healthy: storageHealth.healthy },
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'Health check failed');
      res.status(503).json({ status: 'unhealthy', service: 'api-gateway' });
    }
  });
  // /healthz — liveness probe (lightweight, always pass if process is up)
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'pass' });
  });
  app.get('/.well-known/apollo/server-health', (_req, res) => {
    res.json({ status: 'pass' });
  });

  // ── Admin endpoints ──
  // Register Prometheus gauges for loaded packs
  for (const info of packInfos) {
    packLoaded.set(
      { name: info.manifest.name, version: info.manifest.version, origin: info.external ? 'external' : 'primary' },
      1,
    );
  }

  // GET /admin/packs — introspection of loaded domain packs
  app.get('/admin/packs', (_req, res) => {
    res.json({
      packs: packInfos.map(info => ({
        name: info.manifest.name,
        version: info.manifest.version,
        namespace: info.manifest.namespace,
        description: info.manifest.description ?? null,
        external: info.external,
        objectTypes: info.typeCounts.objectTypes,
        linkTypes: info.typeCounts.linkTypes,
        actionTypes: info.typeCounts.actionTypes,
        connectors: connectorManifests.filter(c => c.packName === info.manifest.name).length,
        permissions: (info.manifest.permissions ?? []).filter(f => f.endsWith('.fga')).length,
      })),
      totals: {
        objectTypes: schema.objectTypes.length,
        linkTypes: schema.linkTypes.length,
        actionTypes: schema.actionTypes.length,
        connectors: connectorManifests.length,
      },
    });
  });

  // ── GraphQL at /graphql ──
  app.use(
    '/graphql',
    expressMiddleware(apolloServer, {
      context: async ({ req }): Promise<ResolverContext> => {
        authorizationService.clearFieldCache();
        try {
          const user = await extractUser(req, authenticator, isDev);

          // Rate limit check
          const rlResult = await rateLimiter.check({ tenantId: user.tenantId, principalId: user.id } as RateLimitIdentity);
          if (!rlResult.allowed) {
            throw new GraphQLError(`Rate limit exceeded (by ${rlResult.exceededBy})`, {
              extensions: {
                code: 'RATE_LIMITED',
                http: { status: 429 },
                retryAfter: Math.ceil((rlResult.resetAt - Date.now()) / 1000),
              },
            });
          }

          return buildResolverContext(user, deps);
        } catch (err) {
          // Map auth failures to proper GraphQL errors with 401 status
          if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 401) {
            throw new GraphQLError('Authentication required', {
              extensions: {
                code: 'UNAUTHENTICATED',
                http: { status: 401 },
              },
            });
          }
          throw err;
        }
      },
    }),
  );

  // ── REST at /api/v1/* ──
  const restRoutes = [
    ...generateRestRoutes(schema, deps),
    ...generateRelationshipRoutes(deps, grantAllowlist),
    ...generateConsentRoutes(deps),
  ];
  for (const route of restRoutes) {
    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete';
    app[method](route.pattern, async (req, res) => {
      try {
        authorizationService.clearFieldCache();
        const user = await extractUser(req, authenticator, isDev);

        // Rate limit check
        const rlResult = await rateLimiter.check({ tenantId: user.tenantId, principalId: user.id } as RateLimitIdentity);
        if (!rlResult.allowed) {
          res.setHeader('Retry-After', String(Math.ceil((rlResult.resetAt - Date.now()) / 1000)));
          res.status(429).json({ error: { code: 'RATE_LIMITED', message: `Rate limit exceeded (by ${rlResult.exceededBy})`, retryable: true } });
          return;
        }

        const restReq: RestRequest = {
          method: req.method,
          path: req.path,
          params: req.params as Record<string, string>,
          query: req.query as Record<string, string>,
          body: req.body as Record<string, unknown>,
          user,
        };
        const ctx: ResolverContext = buildResolverContext(user, deps);
        const result = await route.handler(restReq, ctx);
        res.status(result.status).json(result.body);
      } catch (err) {
        if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 401) {
          res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
          return;
        }
        logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'REST handler error');
        res.status(500).json({
          error: {
            code: 'INTERNAL_ERROR',
            category: 'system',
            message: 'Internal server error',
            retryable: false,
            details: {},
            traceId: 'unknown',
            timestamp: new Date().toISOString(),
          },
        });
      }
    });
  }

  // ── OpenAPI spec at /api/v1/openapi.json ──
  // Stamp the served contract with the real platform version (root package.json)
  // so it matches the released spec artifact, not the generator's default.
  const openApiSpec = generateOpenApiSpec(schema, readPlatformVersion());
  app.get('/api/v1/openapi.json', (_req, res) => {
    res.json(openApiSpec);
  });

  // ── FDP/CDM projection at /api/v1/cdm/* (S1.0) — mounted only with `cdm`.
  // cdmEnabled/fhirEnabled were resolved above (before GraphQL schema build) so
  // the REST mount, GraphQL SDL, and GraphQL resolvers all gate identically. ──
  if (cdmEnabled) {
  const cdmHandler = createCdmRouter({ deps });
  // Public metadata: profile, compatibility matrix, gap register (non-sensitive
  // schema mapping info — mirrors the public openapi.json endpoint).
  // Registered for both GET and HEAD so the advertised contract holds before
  // the authenticated catch-all below.
  const cdmMetadataHandler: express.RequestHandler = async (req, res) => {
    const result = await cdmHandler({ method: req.method, path: 'metadata', query: {} });
    for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
    res.status(result.status).json(result.body);
  };
  app.get('/api/v1/cdm/metadata', cdmMetadataHandler);
  app.head('/api/v1/cdm/metadata', cdmMetadataHandler);
  // Authenticated data projections.
  app.all('/api/v1/cdm/*', async (req, res) => {
    try {
      authorizationService.clearFieldCache();
      const user = await extractUser(req, authenticator, isDev);

      const rlResult = await rateLimiter.check({ tenantId: user.tenantId, principalId: user.id } as RateLimitIdentity);
      if (!rlResult.allowed) {
        res.setHeader('Retry-After', String(Math.ceil((rlResult.resetAt - Date.now()) / 1000)));
        res.status(429).json({ error: { code: 429, message: 'Rate limit exceeded' } });
        return;
      }

      const result = await cdmHandler({
        method: req.method,
        path: req.path.replace(/^\/api\/v1\/cdm/, ''),
        query: req.query as Record<string, string>,
        user,
      });
      for (const [key, value] of Object.entries(result.headers)) {
        res.setHeader(key, value);
      }
      // Dataset-export routes return a pre-serialised string (NDJSON/CSV) with
      // their own Content-Type; send it raw rather than JSON-encoding it.
      if (typeof result.body === 'string') {
        res.status(result.status).send(result.body);
      } else {
        res.status(result.status).json(result.body);
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 401) {
        res.status(401).json({ error: { code: 401, message: 'Authentication required' } });
        return;
      }
      logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'CDM handler error');
      res.status(500).json({ error: { code: 500, message: 'Internal server error' } });
    }
  });
  } // end cdm capability gate

  // ── FHIR at /fhir/* — mounted only when a pack declares the `fhir` capability ──
  if (fhirEnabled) {
  const fhirBaseUrl = process.env['FHIR_BASE_URL'] ?? `http://localhost:${PORT}/fhir`;
  if (!isDev && !process.env['FHIR_BASE_URL']) {
    logger.warn('WARNING: FHIR_BASE_URL not set — Bundle fullUrl links will use http://localhost. Set FHIR_BASE_URL to the externally routable address.');
  }
  const fhirHandler = createFhirRouter({ deps, baseUrl: fhirBaseUrl });
  app.all('/fhir/*', async (req, res) => {
    try {
      authorizationService.clearFieldCache();
      const user = await extractUser(req, authenticator, isDev);

      // Rate limit check
      const rlResult = await rateLimiter.check({ tenantId: user.tenantId, principalId: user.id } as RateLimitIdentity);
      if (!rlResult.allowed) {
        res.setHeader('Retry-After', String(Math.ceil((rlResult.resetAt - Date.now()) / 1000)));
        res.status(429).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'throttled', diagnostics: 'Rate limit exceeded' }] });
        return;
      }

      const fhirReq = {
        method: req.method,
        path: req.path.replace(/^\/fhir/, ''),
        query: req.query as Record<string, string>,
        user,
      };
      const result = await fhirHandler(fhirReq);
      if (result.headers) {
        for (const [key, value] of Object.entries(result.headers)) {
          res.setHeader(key, value);
        }
      }
      res.status(result.status).json(result.body);
    } catch (err) {
      if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 401) {
        res.status(401).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'login', diagnostics: 'Authentication required' }] });
        return;
      }
      logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'FHIR handler error');
      res.status(500).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'fatal', code: 'exception', diagnostics: 'Internal server error' }] });
    }
  });
  } // end fhir capability gate

  // ── Graceful shutdown ──
  const SHUTDOWN_TIMEOUT_MS = 5_000;

  async function shutdown() {
    logger.info('Shutting down...');
    stopHealthGauge();
    subscriptionManager.stop();
    await apolloServer.stop();
    if (cel instanceof CelClient) {
      cel.close();
    }
    // Disconnect persistent event bus (Redpanda/Kafka) with timeout
    if (eventBus instanceof RedpandaEventBus) {
      try {
        await Promise.race([
          eventBus.disconnect(),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), SHUTDOWN_TIMEOUT_MS)),
        ]);
        logger.info('EventBus: disconnected');
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'EventBus disconnect error');
      }
    }
    // Close Redis connection (distributed rate limiting) with timeout
    if (redisClient) {
      try {
        await Promise.race([
          redisClient.quit(),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), SHUTDOWN_TIMEOUT_MS)),
        ]);
        logger.info('Redis: disconnected');
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'Redis disconnect error');
      }
    }
    if (storage instanceof PostgresStorageProvider) {
      await storage.close();
    }
    // Flush pending OTEL spans before exit
    const { shutdownTelemetry } = await import('@openfoundry/observability');
    await shutdownTelemetry();
    httpServer.close();
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // ── Start ──
  await new Promise<void>((resolve) => {
    httpServer.listen(PORT, resolve);
  });

  const mode = isDev ? 'DEVELOPMENT' : 'PRODUCTION';
  const imageRevision = process.env['GIT_REVISION'] ?? 'unknown';
  logger.info(`Open Foundry API gateway [${mode}] listening at http://localhost:${PORT} (rev: ${imageRevision.slice(0, 8)})`);
  logger.info(`  GraphQL:  http://localhost:${PORT}/graphql`);
  logger.info(`  WS Subs:  ws://localhost:${PORT}/graphql`);
  logger.info(`  REST:     http://localhost:${PORT}/api/v1/`);
  logger.info(`  FHIR:     http://localhost:${PORT}/fhir/`);
  logger.info(`  Metrics:  http://localhost:${PORT}/metrics`);
}

/**
 * Build the link → ReBAC-tuple sync map. For each link type whose
 * `snake(linkType)` relation exists on its from-type in the merged OpenFGA
 * model, map it so the action pipeline mints `(toType:toId, relation,
 * fromType:fromId)` tuples on link create/delete. Links without a matching
 * model relation (e.g. dropped by a permission override) are skipped.
 */
function buildLinkTupleMap(
  schema: import('@openfoundry/odl').ParsedSchema,
  model: FgaAuthorizationModel,
): LinkTupleMap {
  const relationsByType = new Map<string, Set<string>>();
  for (const td of model.type_definitions) {
    relationsByType.set(td.type, new Set(Object.keys(td.relations ?? {})));
  }
  const map: LinkTupleMap = new Map();
  for (const lt of schema.linkTypes) {
    const fromType = toSnakeCase(lt.from);
    const toType = toSnakeCase(lt.to);
    const relation = toSnakeCase(lt.name);
    if (relationsByType.get(fromType)?.has(relation)) {
      map.set(lt.name, { relation, fromType, toType });
    }
  }
  return map;
}

/**
 * Build action authorization mappings from the parsed schema's actionTypes.
 * Extracts verb from PascalCase name, finds first object-typed param.
 * Uses snake_case for FGA object types (matching OpenFGA codegen convention).
 */
function deriveActionAuthzMappings(
  schema: import('@openfoundry/odl').ParsedSchema,
): Map<string, ActionAuthzMapping> {
  const mappings = new Map<string, ActionAuthzMapping>();
  const objectTypeNames = new Set(schema.objectTypes.map(o => o.name));

  for (const action of schema.actionTypes) {
    // Extract verb: "AdmitPatient" → "admit", "DischargePatient" → "discharge", "TransferWard" → "transfer"
    const verbMatch = action.name.match(/^([A-Z][a-z]+)/);
    if (!verbMatch) continue;
    const verb = verbMatch[1]!.toLowerCase();
    const relation = `can_${verb}`;

    // Find first @param field that references an ObjectType (the authorization target)
    const paramFields = action.fields.filter(f =>
      f.directives.some(d => d.kind === 'param'),
    );
    const objectParam = paramFields.find(f => objectTypeNames.has(f.type.name));
    if (!objectParam) continue;

    mappings.set(action.name, {
      relation,
      objectType: toSnakeCase(objectParam.type.name),
      objectIdParam: objectParam.name,
    });
  }

  return mappings;
}

/** OpenFGA relation body — one of direct, computed, tuple-to-userset, or union. */
export interface FgaRelationBody {
  this?: Record<string, never>;
  computedUserset?: { relation: string };
  tupleToUserset?: { tupleset: { relation: string }; computedUserset: { relation: string } };
  union?: { child: FgaRelationBody[] };
}

/** Single type definition in the OpenFGA authorization model JSON. */
export interface FgaTypeDef {
  type: string;
  relations?: Record<string, FgaRelationBody>;
  metadata?: {
    relations: Record<string, { directly_related_user_types: Array<{ type: string }> }>;
  };
}

/** OpenFGA authorization model JSON accepted by the REST API. */
export interface FgaAuthorizationModel {
  schema_version: string;
  type_definitions: FgaTypeDef[];
}

/**
 * Convert OpenFGA DSL (schema 1.1) to the JSON format accepted by the
 * OpenFGA REST API POST /stores/{id}/authorization-models.
 *
 * Handles: direct types [user], computed usersets (derived), tuple-to-userset
 * (from), and union (or) relations.
 */
export function fgaDslToJson(dsl: string): FgaAuthorizationModel {
  const typeDefs: FgaTypeDef[] = [];
  const lines = dsl.split('\n');
  let currentType: string | null = null;
  let relations: Record<string, FgaRelationBody> = {};
  let metadata: Record<string, { directly_related_user_types: Array<{ type: string }> }> = {};

  function flushType() {
    if (currentType !== null) {
      const def: FgaTypeDef = { type: currentType };
      if (Object.keys(relations).length > 0) {
        def.relations = relations;
        const metaRelations: Record<string, { directly_related_user_types: Array<{ type: string }> }> = {};
        for (const [rel, types] of Object.entries(metadata)) {
          if (types.directly_related_user_types.length > 0) {
            metaRelations[rel] = types;
          }
        }
        if (Object.keys(metaRelations).length > 0) {
          def.metadata = { relations: metaRelations };
        }
      }
      typeDefs.push(def);
    }
    relations = {};
    metadata = {};
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('model') || trimmed.startsWith('schema')) continue;

    const typeMatch = trimmed.match(/^type\s+(\w+)$/);
    if (typeMatch) {
      flushType();
      currentType = typeMatch[1]!;
      continue;
    }

    if (trimmed === 'relations') continue;

    const defineMatch = trimmed.match(/^define\s+(\w+):\s*(.+)$/);
    if (defineMatch && currentType) {
      const relName = defineMatch[1]!;
      const body = defineMatch[2]!.trim();
      metadata[relName] = { directly_related_user_types: [] };

      // Parse the relation body
      const parts = body.split(/\s+or\s+/);
      if (parts.length === 1) {
        const single = parts[0]!.trim();
        const directMatch = single.match(/^\[(\w+)]$/);
        const fromMatch = single.match(/^(\w+)\s+from\s+(\w+)$/);

        if (directMatch) {
          // Direct assignment: [user]
          relations[relName] = { this: {} };
          metadata[relName]!.directly_related_user_types.push({ type: directMatch[1]! });
        } else if (fromMatch) {
          // Tuple-to-userset: viewer from admitted_to
          relations[relName] = {
            tupleToUserset: {
              tupleset: { relation: fromMatch[2]! },
              computedUserset: { relation: fromMatch[1]! },
            },
          };
        } else {
          // Computed userset: assigned
          relations[relName] = { computedUserset: { relation: single } };
        }
      } else {
        // Union of multiple parts
        const children: FgaRelationBody[] = [];
        for (const part of parts) {
          const p = part.trim();
          const directMatch = p.match(/^\[(\w+)]$/);
          const fromMatch = p.match(/^(\w+)\s+from\s+(\w+)$/);

          if (directMatch) {
            children.push({ this: {} });
            metadata[relName]!.directly_related_user_types.push({ type: directMatch[1]! });
          } else if (fromMatch) {
            children.push({
              tupleToUserset: {
                tupleset: { relation: fromMatch[2]! },
                computedUserset: { relation: fromMatch[1]! },
              },
            });
          } else {
            children.push({ computedUserset: { relation: p } });
          }
        }
        relations[relName] = { union: { child: children } };
      }
    }
  }
  flushType();

  return { schema_version: '1.1', type_definitions: typeDefs };
}

// Fatal error handlers — log and exit rather than silently dying.
// Must be registered before main() so they catch errors during startup too.
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
  process.exit(1);
});

main().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
