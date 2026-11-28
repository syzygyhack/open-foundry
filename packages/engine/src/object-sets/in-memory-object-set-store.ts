/**
 * InMemoryObjectSetStore — in-memory implementation of ObjectSetStore.
 *
 * Map-based store keyed by id with tenant isolation.
 * Used for testing and MVP; production will delegate to a persistent store.
 */

import type { RequestContext, ObjectSetDefinition, ObjectSetStore } from '@openfoundry/spi';
import { OpenFoundryError } from '@openfoundry/spi';
import { generateUUIDv7 } from '../links/index.js';

export class InMemoryObjectSetStore implements ObjectSetStore {
  private readonly store = new Map<string, ObjectSetDefinition>();

  async create(
    ctx: RequestContext,
    def: Omit<ObjectSetDefinition, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ObjectSetDefinition> {
    // Enforce createdBy from request context — fail closed if unauthenticated
    if (!ctx.actorId) {
      throw new OpenFoundryError({
        code: 'UNAUTHENTICATED',
        category: 'authorization',
        message: 'Cannot create object set without authenticated user',
      });
    }
    const now = new Date().toISOString();
    const objectSet: ObjectSetDefinition = {
      ...def,
      id: generateUUIDv7(),
      createdAt: now,
      updatedAt: now,
      tenantId: ctx.tenantId,
      createdBy: ctx.actorId,
    };
    this.store.set(objectSet.id, objectSet);
    return objectSet;
  }

  async get(ctx: RequestContext, id: string): Promise<ObjectSetDefinition | null> {
    const def = this.store.get(id);
    if (!def || def.tenantId !== ctx.tenantId) return null;
    if (!this.isVisible(def, ctx)) return null;
    return def;
  }

  async getByName(ctx: RequestContext, name: string): Promise<ObjectSetDefinition | null> {
    for (const def of this.store.values()) {
      if (def.name === name && def.tenantId === ctx.tenantId && this.isVisible(def, ctx)) {
        return def;
      }
    }
    return null;
  }

  async list(ctx: RequestContext, objectType?: string): Promise<ObjectSetDefinition[]> {
    const results: ObjectSetDefinition[] = [];
    for (const def of this.store.values()) {
      if (def.tenantId !== ctx.tenantId) continue;
      if (objectType && def.objectType !== objectType) continue;
      if (!this.isVisible(def, ctx)) continue;
      results.push(def);
    }
    return results;
  }

  async update(
    ctx: RequestContext,
    id: string,
    updates: Partial<Pick<ObjectSetDefinition, 'name' | 'description' | 'filter' | 'orderBy' | 'limit' | 'aggregation' | 'isPublic'>>,
  ): Promise<ObjectSetDefinition> {
    const existing = this.store.get(id);
    if (!existing || existing.tenantId !== ctx.tenantId) {
      const error = {
        code: 'OBJECT_SET_NOT_FOUND',
        category: 'not_found' as const,
        message: `Object set ${id} not found`,
        retryable: false,
      };
      throw error;
    }
    // Only the creator can update an object set.
    // When actorId is absent, deny access (fail closed).
    if (!ctx.actorId || existing.createdBy !== ctx.actorId) {
      const error = {
        code: 'FORBIDDEN',
        category: 'authorization' as const,
        message: `Only the creator can update object set ${id}`,
        retryable: false,
      };
      throw error;
    }

    const updated: ObjectSetDefinition = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(id, updated);
    return updated;
  }

  async delete(ctx: RequestContext, id: string): Promise<void> {
    const existing = this.store.get(id);
    if (!existing || existing.tenantId !== ctx.tenantId) {
      const error = {
        code: 'OBJECT_SET_NOT_FOUND',
        category: 'not_found' as const,
        message: `Object set ${id} not found`,
        retryable: false,
      };
      throw error;
    }
    // Only the creator can delete an object set.
    // When actorId is absent, deny access (fail closed).
    if (!ctx.actorId || existing.createdBy !== ctx.actorId) {
      const error = {
        code: 'FORBIDDEN',
        category: 'authorization' as const,
        message: `Only the creator can delete object set ${id}`,
        retryable: false,
      };
      throw error;
    }
    this.store.delete(id);
  }

  /**
   * Visibility check: public sets are visible to all; private sets are
   * visible only to the creator. When actorId is absent (unauthenticated),
   * private sets are hidden.
   */
  private isVisible(def: ObjectSetDefinition, ctx: RequestContext): boolean {
    if (def.isPublic) return true;
    if (!ctx.actorId) return false;
    return def.createdBy === ctx.actorId;
  }

  /** Clear all records (test utility). */
  clear(): void {
    this.store.clear();
  }
}
