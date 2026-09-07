/**
 * Domain pack schema loader.
 *
 * Reads pack.yaml manifests from domain pack directories, loads ODL schema
 * files, parses them with the ODL compiler, and produces both a ParsedSchema
 * (for the engine/GraphQL layer) and an OntologySchema (for the SPI storage layer).
 *
 * Configuration via environment variables:
 *   DOMAIN_PACKS_DIR        — path to primary domain-packs directory (default: auto-detected from monorepo)
 *   DOMAIN_PACKS            — comma-separated pack names to load (default: all found; 'core' always included)
 *   DOMAIN_PACKS_EXTRA_DIRS — path-separated additional directories to scan for packs
 *                             (colon on POSIX, semicolon on Windows).
 *                             Each entry may be a directory containing pack subdirectories,
 *                             or a direct path to a single pack directory (containing pack.yaml).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { parseOdl } from '@openfoundry/odl';
import type { ParsedSchema, ObjectType, LinkType } from '@openfoundry/odl';
import { parseActionManifest } from '@openfoundry/actions';
import { logger } from './logger.js';
import type { ActionManifest } from '@openfoundry/actions';
import type { OntologySchema, ObjectTypeDefinition, LinkTypeDefinition, PropertyDefinition, IndexDefinition } from '@openfoundry/spi';
import type { FieldPermissionConfig } from '@openfoundry/security';
import type { ManifestRegistry } from './graphql/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PackManifest {
  name: string;
  version: string;
  namespace: string;
  description?: string;
  dependencies?: Record<string, string>;
  schema?: string[];
  actions?: string[];
  connectors?: string[];
  permissions?: string[];
  seed?: string[];
  /**
   * Optional platform capabilities this pack opts into (e.g. "fhir", "cdm").
   * Capability-gated API surfaces (the FHIR facade, the FDP/CDM projection) are
   * only mounted when at least one loaded pack declares them — so a non-NHS
   * deployment is not forced to expose NHS-shaped endpoints.
   */
  capabilities?: string[];
}

/** Connector manifest loaded from a domain pack. */
export interface ConnectorManifest {
  /** Connector plugin type (e.g. "jdbc", "rest"). */
  connector: string;
  /** Raw parsed YAML content. */
  config: Record<string, unknown>;
  /** Pack that declared this connector. */
  packName: string;
}

/** A single seed object to create at bootstrap. */
export interface SeedObject {
  /** Object type name (must exist in the schema). */
  type: string;
  /** Local reference label for use in seed link `from`/`to` fields. */
  ref?: string;
  /** Field values for the object. */
  fields: Record<string, unknown>;
}

/** A single seed link to create at bootstrap. */
export interface SeedLink {
  /** Link type name (must exist in the schema). */
  type: string;
  /** Source object — either a seed `ref` label or a literal object ID. */
  from: string;
  /** Target object — either a seed `ref` label or a literal object ID. */
  to: string;
  /** Optional link properties. */
  fields?: Record<string, unknown>;
}

/** Seed manifest loaded from a domain pack's seed/*.yaml files. */
export interface SeedManifest {
  /** Pack that declared this seed. */
  packName: string;
  /** Objects to create (in order). */
  objects: SeedObject[];
  /** Links to create (in order, after objects). */
  links: SeedLink[];
}

/** Metadata about a loaded pack, including its origin. */
export interface LoadedPackInfo {
  manifest: PackManifest;
  /** Absolute path to the pack directory. */
  packDir: string;
  /** Whether this pack came from an extra directory (external). */
  external: boolean;
  /** Per-pack type counts from ODL parsing. */
  typeCounts: { objectTypes: number; linkTypes: number; actionTypes: number; enums: number };
}

export interface LoadedSchema {
  /** Combined ParsedSchema for engine + GraphQL layers. */
  parsed: ParsedSchema;
  /** OntologySchema for storage.applySchema(). */
  spiSchema: OntologySchema;
  /** Pack manifests that were loaded. */
  packs: PackManifest[];
  /** Detailed pack info including origin. */
  packInfos: LoadedPackInfo[];
  /** Action manifests (ManifestRegistry for action executor). */
  manifestRegistry: ManifestRegistry;
  /** Field permission configurations for field-level redaction. */
  fieldPermissions: FieldPermissionConfig[];
  /** OpenFGA permission override DSL strings from pack permissions/*.fga files. */
  permissionOverrides: string[];
  /** Connector manifests from pack connectors/*.yaml files. */
  connectorManifests: ConnectorManifest[];
  /** Seed manifests from pack seed/*.yaml files. */
  seedManifests: SeedManifest[];
}

// ---------------------------------------------------------------------------
// Pack discovery
// ---------------------------------------------------------------------------

/**
 * Resolve the domain-packs directory.
 * Tries DOMAIN_PACKS_DIR env var first, then walks up from this file to find
 * the monorepo root (where domain-packs/ lives).
 */
function resolvePacksDir(): string {
  if (process.env['DOMAIN_PACKS_DIR']) {
    return process.env['DOMAIN_PACKS_DIR'];
  }

  // Walk up from packages/api/src/ → packages/api/ → packages/ → root
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const monorepoRoot = resolve(thisDir, '..', '..', '..');
  const packsDir = resolve(monorepoRoot, 'domain-packs');

  if (existsSync(packsDir)) {
    return packsDir;
  }

  // Docker/production layout: /app/domain-packs
  if (existsSync('/app/domain-packs')) {
    return '/app/domain-packs';
  }

  throw new Error(
    'Cannot find domain-packs directory. Set DOMAIN_PACKS_DIR or ensure the monorepo layout is intact.',
  );
}

/**
 * Discover available pack names in the domain-packs directory.
 */
function discoverPacks(packsDir: string): string[] {
  return readdirSync(packsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(resolve(packsDir, d.name, 'pack.yaml')))
    .map(d => d.name)
    // Sort for deterministic discovery order: readdirSync order is
    // filesystem-dependent, and the merged schema preserves pack order, so an
    // unsorted list makes the same logical schema serialize differently across
    // boots (spurious schema-registry versions).
    .sort();
}

/**
 * Resolve additional pack directories from DOMAIN_PACKS_EXTRA_DIRS env var.
 * Uses the platform path delimiter (colon on POSIX, semicolon on Windows).
 * Returns empty array if unset.
 */
function resolveExtraDirs(): string[] {
  const raw = process.env['DOMAIN_PACKS_EXTRA_DIRS'];
  if (!raw) return [];
  return raw.split(delimiter).map(s => s.trim()).filter(Boolean);
}

/**
 * Discover packs from an external filesystem path.
 *
 * Smart detection: if the path itself contains pack.yaml, treat it as a single
 * pack directory (pack name read from manifest). Otherwise scan for subdirectories
 * containing pack.yaml — same behaviour as the primary domain-packs directory.
 *
 * @returns Map of pack name (from manifest) → absolute pack directory path.
 */
function discoverPacksFromPath(dir: string): Map<string, string> {
  const result = new Map<string, string>();

  if (!existsSync(dir)) {
    logger.warn(`Schema loader: extra packs path '${dir}' does not exist, skipping`);
    return result;
  }

  // If this directory IS a pack, use it directly
  if (existsSync(resolve(dir, 'pack.yaml'))) {
    try {
      const manifest = readManifest(dir);
      result.set(manifest.name, dir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Schema loader: skipping pack at ${dir}: ${msg}`);
    }
    return result;
  }

  // Otherwise scan subdirectories
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const packDir = resolve(dir, entry.name);
      if (existsSync(resolve(packDir, 'pack.yaml'))) {
        try {
          const manifest = readManifest(packDir);
          result.set(manifest.name, packDir);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`Schema loader: skipping pack at ${packDir}: ${msg}`);
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pack loading
// ---------------------------------------------------------------------------

/**
 * Read and parse a pack.yaml manifest.
 */
function readManifest(packDir: string): PackManifest {
  const yamlPath = resolve(packDir, 'pack.yaml');
  const content = readFileSync(yamlPath, 'utf-8');
  const parsed = parseYaml(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid pack.yaml at ${yamlPath}: expected an object`);
  }
  const manifest = parsed as Record<string, unknown>;
  if (typeof manifest['name'] !== 'string' || !manifest['name']) {
    throw new Error(`Invalid pack.yaml at ${yamlPath}: missing required 'name' field`);
  }
  return manifest as unknown as PackManifest;
}

/**
 * Load ODL source from a single domain pack.
 * Reads all schema files listed in pack.yaml, concatenates them,
 * and strips duplicate namespace directives (keeping only the first).
 */
function loadPackOdl(packDir: string, manifest: PackManifest): string {
  const schemaFiles = manifest.schema ?? [];
  if (schemaFiles.length === 0) return '';

  const sources = schemaFiles.map(f => readFileSync(resolve(packDir, f), 'utf-8'));

  // Keep namespace directive only from the first file
  const first = sources[0];
  const rest = sources.slice(1).map(s =>
    s.replace(/^extend schema @namespace\([^)]+\)\s*/m, ''),
  );
  return [first, ...rest].join('\n\n');
}

/**
 * Load action YAML manifests from a domain pack.
 * Parses each file listed in pack.yaml actions: and adds valid manifests to the map.
 *
 * Structural validation is strict (invalid manifests are fatal).
 * Schema cross-reference validation is handled separately post-merge:
 * the loadDomainPacks function verifies every @actionType has a manifest.
 */
function loadPackActions(
  packDir: string,
  manifest: PackManifest,
  manifests: Map<string, ActionManifest>,
): void {
  const actionFiles = manifest.actions ?? [];
  for (const file of actionFiles) {
    const filePath = resolve(packDir, file);
    if (!existsSync(filePath)) {
      logger.warn(`Schema loader: action file '${file}' not found in ${packDir}, skipping`);
      continue;
    }
    const yamlContent = readFileSync(filePath, 'utf-8');
    // Structural validation only — cross-ref checked post-merge
    const result = parseActionManifest(yamlContent);
    if (result.valid && result.manifest) {
      manifests.set(result.manifest.action, result.manifest);
    } else {
      // Structural errors are fatal — manifest must parse correctly
      const errors = result.errors.map(e => e.message).join('; ');
      throw new Error(`Schema loader: action manifest '${file}' is invalid: ${errors}`);
    }
  }
}

/**
 * Load field permission configurations from a domain pack.
 * Looks for permissions/field-permissions.yaml in the pack directory.
 */
function loadPackFieldPermissions(
  packDir: string,
  _manifest: PackManifest,
  configs: FieldPermissionConfig[],
): void {
  const filePath = resolve(packDir, 'permissions', 'field-permissions.yaml');
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(content);
  if (!Array.isArray(parsed)) return;

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const objectType = e['objectType'];
    const alwaysVisible = Array.isArray(e['alwaysVisible']) ? e['alwaysVisible'] as string[] : [];
    const fieldsByRelation: Record<string, string[]> = {};

    if (e['fieldsByRelation'] && typeof e['fieldsByRelation'] === 'object') {
      for (const [relation, fields] of Object.entries(e['fieldsByRelation'] as Record<string, unknown>)) {
        if (Array.isArray(fields)) {
          fieldsByRelation[relation] = fields as string[];
        }
      }
    }

    if (typeof objectType === 'string') {
      configs.push({ objectType, alwaysVisible, fieldsByRelation });
    }
  }
}

/**
 * Load OpenFGA permission DSL files from a domain pack.
 * Reads each file listed in pack.yaml permissions: that ends in .fga.
 * Returns raw DSL strings for merging with the auto-generated model.
 */
function loadPackPermissions(
  packDir: string,
  manifest: PackManifest,
  overrides: string[],
): void {
  const permFiles = manifest.permissions ?? [];
  for (const file of permFiles) {
    if (!file.endsWith('.fga')) continue;
    const filePath = resolve(packDir, file);
    if (!existsSync(filePath)) {
      logger.warn(`Schema loader: permission file '${file}' not found in ${packDir}, skipping`);
      continue;
    }
    const content = readFileSync(filePath, 'utf-8');
    if (content.trim()) {
      overrides.push(content);
    }
  }
}

/**
 * Load connector YAML manifests from a domain pack.
 * Reads each file listed in pack.yaml connectors: and returns parsed configs.
 */
function loadPackConnectors(
  packDir: string,
  manifest: PackManifest,
  connectors: ConnectorManifest[],
): void {
  const connectorFiles = manifest.connectors ?? [];
  for (const file of connectorFiles) {
    const filePath = resolve(packDir, file);
    if (!existsSync(filePath)) {
      logger.warn(`Schema loader: connector file '${file}' not found in ${packDir}, skipping`);
      continue;
    }
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseYaml(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn(`Schema loader: connector file '${file}' in ${packDir} is not a valid YAML object, skipping`);
      continue;
    }
    const config = parsed as Record<string, unknown>;
    const connectorType = typeof config['connector'] === 'string' ? config['connector'] : 'unknown';
    connectors.push({
      connector: connectorType,
      config,
      packName: manifest.name,
    });
  }
}

/**
 * Load seed YAML files from a domain pack.
 * Each seed file contains `objects:` and/or `links:` arrays.
 */
function loadPackSeeds(
  packDir: string,
  manifest: PackManifest,
  seeds: SeedManifest[],
): void {
  const seedFiles = manifest.seed ?? [];
  for (const file of seedFiles) {
    const filePath = resolve(packDir, file);
    if (!existsSync(filePath)) {
      logger.warn(`Schema loader: seed file '${file}' not found in ${packDir}, skipping`);
      continue;
    }
    const content = readFileSync(filePath, 'utf-8');
    const parsed = parseYaml(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn(`Schema loader: seed file '${file}' in ${packDir} is not a valid YAML object, skipping`);
      continue;
    }
    const raw = parsed as Record<string, unknown>;
    const objects: SeedObject[] = [];
    const links: SeedLink[] = [];

    if (Array.isArray(raw['objects'])) {
      for (const obj of raw['objects']) {
        if (obj && typeof obj === 'object' && typeof (obj as Record<string, unknown>)['type'] === 'string') {
          const o = obj as Record<string, unknown>;
          objects.push({
            type: o['type'] as string,
            ref: typeof o['ref'] === 'string' ? o['ref'] : undefined,
            fields: (o['fields'] && typeof o['fields'] === 'object' ? o['fields'] : {}) as Record<string, unknown>,
          });
        }
      }
    }

    if (Array.isArray(raw['links'])) {
      for (const lnk of raw['links']) {
        if (lnk && typeof lnk === 'object') {
          const l = lnk as Record<string, unknown>;
          if (typeof l['type'] === 'string' && typeof l['from'] === 'string' && typeof l['to'] === 'string') {
            links.push({
              type: l['type'] as string,
              from: l['from'] as string,
              to: l['to'] as string,
              fields: (l['fields'] && typeof l['fields'] === 'object' ? l['fields'] : undefined) as Record<string, unknown> | undefined,
            });
          }
        }
      }
    }

    if (objects.length > 0 || links.length > 0) {
      seeds.push({ packName: manifest.name, objects, links });
    }
  }
}

// ---------------------------------------------------------------------------
// Dependency validation
// ---------------------------------------------------------------------------

/**
 * Compare two semver-like version strings (e.g. "1.0.0" vs "2.1.3").
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Check if a version satisfies a simple constraint (>=X.Y.Z).
 * Only supports the >=X.Y.Z format used in pack.yaml dependencies.
 */
function satisfiesConstraint(version: string, constraint: string): boolean {
  const trimmed = constraint.trim();
  const gteMatch = trimmed.match(/^>=\s*(.+)$/);
  if (gteMatch) {
    return compareSemver(version, gteMatch[1]!) >= 0;
  }
  // Exact match fallback
  return compareSemver(version, trimmed) === 0;
}

/**
 * Validate that all loaded packs have their declared dependencies satisfied.
 * Checks against the version of the other loaded packs (matched by namespace).
 * Warns on unsatisfied constraints — does not abort.
 */
function validatePackDependencies(manifests: PackManifest[]): void {
  // Build a map of namespace → version from loaded packs
  const loadedVersions = new Map<string, string>();
  for (const m of manifests) {
    loadedVersions.set(m.namespace, m.version);
  }

  for (const m of manifests) {
    if (!m.dependencies) continue;
    for (const [depNamespace, constraint] of Object.entries(m.dependencies)) {
      const depVersion = loadedVersions.get(depNamespace);
      if (!depVersion) {
        logger.warn(
          `Pack '${m.name}' depends on '${depNamespace}' (${constraint}) but it is not loaded`,
        );
        continue;
      }
      if (!satisfiesConstraint(depVersion, constraint)) {
        logger.warn(
          `Pack '${m.name}' requires '${depNamespace}' ${constraint} but loaded version is ${depVersion}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate field permission configs against the merged schema.
 * Warns on invalid object types or field names to catch config drift early.
 */
function validateFieldPermissions(
  configs: FieldPermissionConfig[],
  schema: ParsedSchema,
): void {
  const objectTypes = new Map(schema.objectTypes.map(o => [o.name, o]));

  for (const config of configs) {
    const objType = objectTypes.get(config.objectType);
    if (!objType) {
      logger.warn(
        `Field permissions: unknown object type "${config.objectType}". ` +
        `Known types: ${[...objectTypes.keys()].join(', ')}`,
      );
      continue;
    }

    // Collect stored fields eligible for object-field redaction.
    const storedFields = new Set<string>();
    for (const field of objType.fields) {
      if (field.directives.some(d => d.kind === 'primary')) {
        storedFields.add('id'); // primary maps to 'id' in API
        continue;
      }
      if (field.directives.some(d => d.kind === 'link' || d.kind === 'computed')) continue;
      storedFields.add(field.name);
    }

    // Validate alwaysVisible
    for (const f of config.alwaysVisible) {
      if (f !== 'id' && !storedFields.has(f)) {
        logger.warn(
          `Field permissions [${config.objectType}]: alwaysVisible field "${f}" is not a stored field eligible for redaction. ` +
          `Valid: ${[...storedFields].join(', ')}`,
        );
      }
    }

    // Validate fieldsByRelation
    for (const [relation, fields] of Object.entries(config.fieldsByRelation)) {
      for (const f of fields) {
        if (!storedFields.has(f)) {
          logger.warn(
            `Field permissions [${config.objectType}].${relation}: field "${f}" is not a stored field eligible for redaction. ` +
            `Valid: ${[...storedFields].join(', ')}`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Schema merging
// ---------------------------------------------------------------------------

/**
 * Merge multiple ParsedSchemas into one combined schema.
 * Later packs override earlier ones on name conflicts.
 */
function mergeSchemas(schemas: ParsedSchema[]): ParsedSchema {
  const merged: ParsedSchema = {
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    enums: [],
    interfaces: [],
    scalars: [],
  };

  const seenObjects = new Set<string>();
  const seenLinks = new Set<string>();
  const seenEnums = new Set<string>();
  const seenInterfaces = new Set<string>();
  const seenScalars = new Set<string>();

  for (const schema of schemas) {
    for (const obj of schema.objectTypes) {
      if (!seenObjects.has(obj.name)) {
        merged.objectTypes.push(obj);
        seenObjects.add(obj.name);
      }
    }
    for (const link of schema.linkTypes) {
      if (!seenLinks.has(link.name)) {
        merged.linkTypes.push(link);
        seenLinks.add(link.name);
      }
    }
    for (const action of schema.actionTypes) {
      merged.actionTypes.push(action);
    }
    for (const e of schema.enums) {
      if (!seenEnums.has(e.name)) {
        merged.enums.push(e);
        seenEnums.add(e.name);
      }
    }
    for (const iface of schema.interfaces) {
      if (!seenInterfaces.has(iface.name)) {
        merged.interfaces.push(iface);
        seenInterfaces.add(iface.name);
      }
    }
    for (const scalar of schema.scalars) {
      if (!seenScalars.has(scalar.name)) {
        merged.scalars.push(scalar);
        seenScalars.add(scalar.name);
      }
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// ParsedSchema → OntologySchema conversion
// ---------------------------------------------------------------------------

/** Map ODL FieldTypeRef.name to SPI property type (capitalized for pgType compatibility). */
function mapFieldType(typeName: string): string {
  // ODL uses GraphQL scalar names which are already capitalized
  // and match what pgType() expects.
  return typeName;
}

/**
 * Convert a ParsedSchema ObjectType to an SPI ObjectTypeDefinition.
 * Strips the 'id' field (handled by system columns) and extracts indexes.
 */
function convertObjectType(objType: ObjectType): ObjectTypeDefinition {
  const properties: PropertyDefinition[] = [];
  const indexes: IndexDefinition[] = [];

  for (const field of objType.fields) {
    // Skip 'id' — handled as system column _id
    if (field.directives.some(d => d.kind === 'primary')) continue;
    // Skip computed fields — not stored
    if (field.directives.some(d => d.kind === 'computed')) continue;
    // Skip @link virtual fields — resolved at query time
    if (field.directives.some(d => d.kind === 'link')) continue;

    properties.push({
      name: field.name,
      type: mapFieldType(field.type.name),
      required: field.type.nonNull,
    });

    // Extract index definitions from directives
    const hasUnique = field.directives.some(d => d.kind === 'unique');
    const hasIndexed = field.directives.some(d => d.kind === 'indexed');
    const hasSearchable = field.directives.some(d => d.kind === 'searchable');

    if (hasUnique) {
      indexes.push({ field: field.name, indexType: 'BTREE', unique: true });
    } else if (hasIndexed) {
      indexes.push({ field: field.name, indexType: 'BTREE' });
    }
    if (hasSearchable) {
      indexes.push({ field: field.name, indexType: 'FULLTEXT' });
    }
  }

  return {
    name: objType.name,
    properties,
    indexes: indexes.length > 0 ? indexes : undefined,
  };
}

/**
 * Convert a ParsedSchema LinkType to an SPI LinkTypeDefinition.
 */
function convertLinkType(linkType: LinkType): LinkTypeDefinition {
  const properties: PropertyDefinition[] = linkType.fields.map(f => ({
    name: f.name,
    type: mapFieldType(f.type.name),
    required: f.type.nonNull,
  }));

  return {
    name: linkType.name,
    fromType: linkType.from,
    toType: linkType.to,
    cardinality: linkType.cardinality,
    properties: properties.length > 0 ? properties : undefined,
  };
}

/**
 * Convert a ParsedSchema to an OntologySchema suitable for storage.applySchema().
 */
function toOntologySchema(parsed: ParsedSchema): OntologySchema {
  return {
    version: 1,
    objectTypes: parsed.objectTypes.map(convertObjectType),
    linkTypes: parsed.linkTypes.map(convertLinkType),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load domain pack schemas from the filesystem.
 *
 * @param packsDir  - Optional override for primary domain-packs directory.
 * @param packNames - Optional list of pack names to load. If omitted, loads all discovered packs.
 *                    'core' is always loaded first regardless.
 * @param extraDirs - Optional additional directories to scan for packs.
 *                    If omitted, reads DOMAIN_PACKS_EXTRA_DIRS env var (colon-separated).
 *                    Each entry may be a parent directory containing pack subdirectories,
 *                    or a direct path to a single pack directory (containing pack.yaml).
 */
export async function loadDomainPacks(
  packsDir?: string,
  packNames?: string[],
  extraDirs?: string[],
): Promise<LoadedSchema> {
  const primaryDir = packsDir ?? resolvePacksDir();
  const resolvedExtraDirs = extraDirs ?? resolveExtraDirs();

  // Build a map of packName → absolute packDir, primary directory first
  const packMap = new Map<string, string>();
  const externalPacks = new Set<string>();
  for (const name of discoverPacks(primaryDir)) {
    packMap.set(name, resolve(primaryDir, name));
  }

  // Merge packs from extra directories (primary wins on conflicts)
  for (const extraDir of resolvedExtraDirs) {
    const discovered = discoverPacksFromPath(extraDir);
    for (const [name, packDir] of discovered) {
      if (packMap.has(name)) {
        logger.warn(
          `Schema loader: pack '${name}' from ${packDir} skipped — ` +
          `already discovered at ${packMap.get(name)}`,
        );
      } else {
        packMap.set(name, packDir);
        externalPacks.add(name);
        logger.info(`Schema loader: discovered external pack '${name}' at ${packDir}`);
      }
    }
  }

  // Determine which packs to load
  let names: string[];
  if (packNames && packNames.length > 0) {
    names = packNames.filter(n => packMap.has(n));
    for (const n of packNames) {
      if (!packMap.has(n)) {
        logger.warn(`Schema loader: requested pack '${n}' not found in any pack directory`);
      }
    }
  } else {
    names = [...packMap.keys()];
  }

  // Ensure 'core' is loaded first
  names = names.filter(n => n !== 'core');
  if (packMap.has('core')) {
    names = ['core', ...names];
  }

  // Phase 1: Load ODL schemas, permissions, connectors, and field permissions from all packs
  const parsedSchemas: ParsedSchema[] = [];
  const manifests: PackManifest[] = [];
  const packDirs: string[] = [];
  const packInfos: LoadedPackInfo[] = [];
  const fieldPermissions: FieldPermissionConfig[] = [];
  const permissionOverrides: string[] = [];
  const connectorManifests: ConnectorManifest[] = [];
  const seedManifests: SeedManifest[] = [];

  for (const name of names) {
    const packDir = packMap.get(name)!;
    if (!existsSync(resolve(packDir, 'pack.yaml'))) {
      logger.warn(`Schema loader: pack '${name}' not found at ${packDir}, skipping`);
      continue;
    }

    const manifest = readManifest(packDir);
    manifests.push(manifest);
    packDirs.push(packDir);

    let typeCounts = { objectTypes: 0, linkTypes: 0, actionTypes: 0, enums: 0 };
    const odlSource = loadPackOdl(packDir, manifest);
    if (odlSource.trim()) {
      try {
        const parsed = parseOdl(odlSource);
        typeCounts = {
          objectTypes: parsed.objectTypes.length,
          linkTypes: parsed.linkTypes.length,
          actionTypes: parsed.actionTypes.length,
          enums: parsed.enums.length,
        };
        parsedSchemas.push(parsed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Schema loader: failed to parse ODL from pack '${name}': ${msg}`);
      }
    }
    packInfos.push({ manifest, packDir, external: externalPacks.has(name), typeCounts });

    // Load field permission configurations
    loadPackFieldPermissions(packDir, manifest, fieldPermissions);

    // Load OpenFGA permission overrides (.fga files)
    loadPackPermissions(packDir, manifest, permissionOverrides);

    // Load connector manifests
    loadPackConnectors(packDir, manifest, connectorManifests);

    // Load seed manifests
    loadPackSeeds(packDir, manifest, seedManifests);
  }

  const merged = mergeSchemas(parsedSchemas);
  const spiSchema = toOntologySchema(merged);

  // Phase 2: Load action manifests (structural validation only — cross-ref checked in Phase 3)
  const actionManifests = new Map<string, ActionManifest>();
  for (let i = 0; i < manifests.length; i++) {
    loadPackActions(packDirs[i]!, manifests[i]!, actionManifests);
  }

  // Phase 3: Validate all schema-defined actionTypes have matching manifests (fail-closed)
  const missingManifests: string[] = [];
  for (const actionType of merged.actionTypes) {
    if (!actionManifests.has(actionType.name)) {
      missingManifests.push(actionType.name);
    }
  }
  if (missingManifests.length > 0) {
    throw new Error(
      `Schema loader: actionTypes defined in ODL but missing YAML manifests: ${missingManifests.join(', ')}. ` +
      `Each @actionType must have a corresponding action manifest.`,
    );
  }

  // Phase 4: Validate field permissions against merged schema
  validateFieldPermissions(fieldPermissions, merged);

  // Phase 5: Validate pack dependency constraints
  validatePackDependencies(manifests);

  // Build a ManifestRegistry from loaded action manifests
  const manifestRegistry: ManifestRegistry = {
    get(actionName: string) { return actionManifests.get(actionName); },
  };

  return {
    parsed: merged,
    spiSchema,
    packs: manifests,
    packInfos,
    manifestRegistry,
    fieldPermissions,
    permissionOverrides,
    connectorManifests,
    seedManifests,
  };
}
