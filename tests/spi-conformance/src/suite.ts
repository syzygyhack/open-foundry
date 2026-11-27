/**
 * SPI Conformance Suite Factory.
 *
 * Accepts a StorageProvider factory function and registers all
 * conformance test categories. Each category is a self-contained
 * describe() block that operates on a fresh provider instance.
 */

import type { StorageProvider } from '@openfoundry/spi';
import { registerKnownFailures, type KnownFailures } from './known-failures.js';
import { registerSchemaTests } from './categories/schema.js';
import { registerCrudTests } from './categories/crud.js';
import { registerLinkTests } from './categories/links.js';
import { registerQueryTests } from './categories/queries.js';
import { registerTransactionTests } from './categories/transactions.js';
import { registerTemporalTests } from './categories/temporal.js';
import { registerMultiTenancyTests } from './categories/multi-tenancy.js';
import { registerLineageTests } from './categories/lineage.js';
import { registerAggregationTests } from './categories/aggregation.js';
import { registerSearchTests } from './categories/search.js';

export type ProviderFactory = () => StorageProvider | Promise<StorageProvider>;

/**
 * Run the full SPI conformance suite against a provider.
 *
 * @param name - Display name for the provider (e.g. "MemoryStorageProvider")
 * @param factory - Function that returns a fresh provider instance per test suite
 * @param options.knownFailures - Declared divergences for this registration; see
 *   known-failures.ts. Omit it and every test must pass.
 */
export function runConformanceSuite(
  name: string,
  factory: ProviderFactory,
  options: { knownFailures?: KnownFailures } = {},
): void {
  registerKnownFailures(name, options.knownFailures);
  registerSchemaTests(name, factory);
  registerCrudTests(name, factory);
  registerLinkTests(name, factory);
  registerQueryTests(name, factory);
  registerTransactionTests(name, factory);
  registerTemporalTests(name, factory);
  registerMultiTenancyTests(name, factory);
  registerLineageTests(name, factory);
  registerAggregationTests(name, factory);
  registerSearchTests(name, factory);
}
