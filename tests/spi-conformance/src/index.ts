/**
 * SPI Conformance Test Suite
 *
 * Provider-agnostic test factory. Accepts a StorageProvider instance
 * and runs the full conformance suite against it.
 */
export { runConformanceSuite } from './suite.js';
export type { KnownFailure, KnownFailures } from './known-failures.js';
export { createTestFixtures } from './fixtures.js';
