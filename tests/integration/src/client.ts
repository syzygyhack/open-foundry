/**
 * HTTP and GraphQL client helpers for integration tests.
 *
 * Uses native fetch (Node 24+). Provides typed wrappers for:
 * - GraphQL queries/mutations via POST
 * - REST API calls (GET, POST, PUT, DELETE)
 * - FHIR resource reads
 * - Latency measurement
 */

import { CONFIG } from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphQLResponse<T = Record<string, unknown>> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

export interface RestListResponse<T = Record<string, unknown>> {
  data: T[];
  pagination: {
    totalCount: number;
    limit: number;
    offset: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

export interface RestItemResponse<T = Record<string, unknown>> {
  data: T;
}

export interface ActionResponse {
  data: {
    success: boolean;
    actionId: string;
    errors: string[] | null;
    affectedObjects: Array<{ typeName: string; id: string; changeType: string }>;
  };
}

export interface TimedResult<T> {
  result: T;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// GraphQL client
// ---------------------------------------------------------------------------

export async function graphql<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphQLResponse<T>> {
  const response = await fetch(CONFIG.graphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return response.json() as Promise<GraphQLResponse<T>>;
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

export async function restGet<T = Record<string, unknown>>(
  path: string,
  query?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${CONFIG.restBaseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  const response = await fetch(url.toString(), {
    headers: { 'Content-Type': 'application/json' },
  });
  return response.json() as Promise<T>;
}

export async function restPost<T = Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${CONFIG.restBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<T>;
}

export async function restRaw(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${CONFIG.restBaseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

// ---------------------------------------------------------------------------
// FHIR client
// ---------------------------------------------------------------------------

export async function fhirGet<T = Record<string, unknown>>(
  resourcePath: string,
): Promise<T> {
  const response = await fetch(`${CONFIG.fhirBaseUrl}/${resourcePath}`, {
    headers: { 'Accept': 'application/fhir+json' },
  });
  return response.json() as Promise<T>;
}

export async function fhirGetRaw(resourcePath: string): Promise<Response> {
  return fetch(`${CONFIG.fhirBaseUrl}/${resourcePath}`, {
    headers: { 'Accept': 'application/fhir+json' },
  });
}

// ---------------------------------------------------------------------------
// Timing helper
// ---------------------------------------------------------------------------

export async function timed<T>(fn: () => Promise<T>): Promise<TimedResult<T>> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}
