import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateOpenFGASchema,
  mergeOpenFGAOverrides,
  actionPermissionRelation,
} from '@openfoundry/odl';
import { fgaDslToJson } from '../server.js';
import type { FgaTypeDef } from '../server.js';
import { loadDomainPacks } from '../schema-loader.js';
import { toSnakeCase } from '../utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const DOMAIN_PACKS_DIR = resolve(REPO_ROOT, 'domain-packs');
const EXAMPLE_PACK_DIR = resolve(REPO_ROOT, 'examples', 'library-pack');

/**
 * The library pack is the worked example in docs/first-domain-pack.md. A
 * tutorial whose example has quietly stopped working is worse than no tutorial,
 * so this exercises the same loading and authorization-model code the gateway
 * runs at boot.
 */
describe('examples/library-pack (tutorial worked example)', () => {
  async function loadExample() {
    const previous = process.env['DOMAIN_PACKS_EXTRA_DIRS'];
    process.env['DOMAIN_PACKS_EXTRA_DIRS'] = EXAMPLE_PACK_DIR;
    try {
      return await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'library']);
    } finally {
      if (previous === undefined) delete process.env['DOMAIN_PACKS_EXTRA_DIRS'];
      else process.env['DOMAIN_PACKS_EXTRA_DIRS'] = previous;
    }
  }

  it('loads, and declares what the tutorial says it declares', async () => {
    const { parsed, packs, seedManifests } = await loadExample();

    expect(packs.map(p => p.name)).toContain('library');
    expect(parsed.objectTypes.map(o => o.name)).toEqual(
      expect.arrayContaining(['Book', 'Member']),
    );
    expect(parsed.linkTypes.map(l => l.name)).toContain('BorrowedBy');
    expect(parsed.actionTypes.map(a => a.name)).toEqual(
      expect.arrayContaining(['BorrowBook', 'ReturnBook']),
    );
    // Three seeded objects: two books and a member.
    expect(seedManifests.flatMap(s => s.objects)).toHaveLength(3);
  });

  it('ships the field-permissions file the tutorial relies on', async () => {
    const { fieldPermissions } = await loadExample();
    const member = fieldPermissions.find(c => c.objectType === 'Member');
    expect(member).toBeDefined();
    // Redaction only engages for types listed here, and once a type is listed
    // every field is hidden unless allowed — including link fields, which is the
    // subtlety the tutorial calls out.
    expect(member!.alwaysVisible).toEqual(
      expect.arrayContaining(['id', 'memberNumber', 'name', 'books']),
    );
    expect(member!.fieldsByRelation['librarian']).toContain('email');
    expect(member!.alwaysVisible).not.toContain('email');
  });

  it('satisfies the authorization-model contract the tutorial teaches', async () => {
    const { parsed, permissionOverrides } = await loadExample();
    const dsl = permissionOverrides.length > 0
      ? mergeOpenFGAOverrides(generateOpenFGASchema(parsed), permissionOverrides)
      : generateOpenFGASchema(parsed);
    const types = fgaDslToJson(dsl).type_definitions as FgaTypeDef[];
    const relations = new Map(
      types.map(t => [t.type, new Set(Object.keys(t.relations ?? {}))]),
    );

    // Every ObjectType needs `viewer`, or reads fail and production refuses to boot.
    for (const name of ['Book', 'Member']) {
      expect(relations.get(toSnakeCase(name))?.has('viewer')).toBe(true);
    }

    // Each action's permission relation must exist on its target type. The pack
    // declares these explicitly via @actionType(permission: "..."), which the
    // tutorial recommends over relying on the derivation.
    const objectTypeNames = new Set(parsed.objectTypes.map(o => o.name));
    const resolved = parsed.actionTypes
      .filter(a => ['BorrowBook', 'ReturnBook'].includes(a.name))
      .map(a => {
        const target = a.fields
          .filter(f => f.directives.some(d => d.kind === 'param'))
          .find(f => objectTypeNames.has(f.type.name))!;
        return {
          action: a.name,
          type: toSnakeCase(target.type.name),
          relation: actionPermissionRelation(a, objectTypeNames),
        };
      });

    expect(resolved).toEqual([
      { action: 'BorrowBook', type: 'book', relation: 'can_borrow' },
      { action: 'ReturnBook', type: 'book', relation: 'can_return' },
    ]);
    for (const r of resolved) {
      expect(relations.get(r.type)?.has(r.relation)).toBe(true);
    }
  });
});
