import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import type { GenerateKeyPairResult } from "jose";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { OidcAuthenticator } from "./oidc-authenticator.js";
import { AuthenticationError } from "./types.js";
import { CIS2_ROLE_MAPPINGS } from "./role-mapping.js";

/**
 * Spin up a minimal JWKS endpoint for testing OIDC token validation
 * with real cryptographic signatures.
 */
let server: http.Server;
let jwksUri: string;
let keyPair: GenerateKeyPairResult;
let wrongKeyPair: GenerateKeyPairResult;

const ISSUER = "https://auth.test.nhs.uk";
const CLIENT_ID = "openfoundry-test";

beforeAll(async () => {
  keyPair = await generateKeyPair("RS256");
  wrongKeyPair = await generateKeyPair("RS256");

  const publicJwk = await exportJWK(keyPair.publicKey);
  publicJwk.kid = "test-key-1";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const jwks = { keys: [publicJwk] };

  server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(jwks));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  jwksUri = `http://127.0.0.1:${addr.port}/.well-known/jwks.json`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function createAuthenticator(overrides?: {
  tenantClaim?: string;
  defaultTenantId?: string;
  roleMapping?: { claimName: string; mappings: Record<string, string> };
}): OidcAuthenticator {
  const auth = new OidcAuthenticator();
  auth.configure({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    jwksUri,
    ...overrides,
  });
  return auth;
}

async function signToken(
  claims: Record<string, unknown>,
  opts?: { privateKey?: GenerateKeyPairResult["privateKey"]; expiresIn?: string; kid?: string },
): Promise<string> {
  const key = opts?.privateKey ?? keyPair.privateKey;
  let builder = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: opts?.kid ?? "test-key-1" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt();

  if (opts?.expiresIn !== undefined) {
    builder = builder.setExpirationTime(opts.expiresIn);
  } else {
    builder = builder.setExpirationTime("1h");
  }

  return builder.sign(key);
}

describe("OidcAuthenticator", () => {
  describe("configuration", () => {
    it("throws when authenticate is called before configure", async () => {
      const auth = new OidcAuthenticator();
      await expect(auth.authenticate("token")).rejects.toThrow(AuthenticationError);
      await expect(auth.authenticate("token")).rejects.toThrow("not been configured");
    });
  });

  describe("valid token authentication", () => {
    it("authenticates a valid JWT and extracts user claims", async () => {
      const auth = createAuthenticator({ defaultTenantId: "nhs-trust-1" });
      const token = await signToken({
        sub: "user-123",
        name: "Dr. Jane Smith",
        email: "jane.smith@nhs.net",
        roles: ["clinician"],
        groups: ["ward-a", "cardiology"],
      });

      const user = await auth.authenticate(token);

      expect(user.id).toBe("user-123");
      expect(user.name).toBe("Dr. Jane Smith");
      expect(user.email).toBe("jane.smith@nhs.net");
      expect(user.roles).toEqual(["clinician"]);
      expect(user.groups).toEqual(["ward-a", "cardiology"]);
      expect(user.tenantId).toBe("nhs-trust-1");
    });

    it("uses tenant_id claim when present", async () => {
      const auth = createAuthenticator();
      const token = await signToken({
        sub: "user-456",
        name: "Nurse Bob",
        email: "bob@nhs.net",
        tenant_id: "trust-xyz",
      });

      const user = await auth.authenticate(token);
      expect(user.tenantId).toBe("trust-xyz");
    });

    it("resolves platform identity from authenticated user", async () => {
      const auth = createAuthenticator({ defaultTenantId: "default" });
      const token = await signToken({
        sub: "user-789",
        name: "Admin",
        email: "admin@nhs.net",
        roles: ["admin", "clinician"],
      });

      const user = await auth.authenticate(token);
      const identity = auth.toPlatformIdentity(user);

      expect(identity).toEqual({
        type: "user",
        id: "user-789",
        roles: ["admin", "clinician"],
      });
    });
  });

  describe("token rejection", () => {
    it("rejects expired JWT", async () => {
      const auth = createAuthenticator({ defaultTenantId: "default" });
      const token = await signToken(
        { sub: "user-expired", name: "Expired", email: "e@nhs.net" },
        { expiresIn: "-1s" },
      );

      await expect(auth.authenticate(token)).rejects.toThrow(AuthenticationError);
      try {
        await auth.authenticate(token);
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
        expect((err as AuthenticationError).code).toBe("TOKEN_EXPIRED");
      }
    });

    it("rejects JWT with invalid signature", async () => {
      const auth = createAuthenticator({ defaultTenantId: "default" });
      const token = await signToken(
        { sub: "user-wrong-key", name: "Wrong", email: "w@nhs.net" },
        { privateKey: wrongKeyPair.privateKey },
      );

      await expect(auth.authenticate(token)).rejects.toThrow(AuthenticationError);
      try {
        await auth.authenticate(token);
      } catch (err) {
        expect(err).toBeInstanceOf(AuthenticationError);
        const authErr = err as AuthenticationError;
        // Could be INVALID_SIGNATURE or VALIDATION_FAILED depending on jose version
        expect(["INVALID_SIGNATURE", "VALIDATION_FAILED"]).toContain(authErr.code);
      }
    });

    it("rejects JWT without sub claim", async () => {
      const auth = createAuthenticator({ defaultTenantId: "default" });
      // Build manually without setSubject
      const token = await new SignJWT({ name: "No Sub" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(keyPair.privateKey);

      await expect(auth.authenticate(token)).rejects.toThrow("sub");
    });

    it("rejects JWT without tenant claim when no default configured", async () => {
      const auth = createAuthenticator(); // no defaultTenantId
      const token = await signToken({
        sub: "user-no-tenant",
        name: "No Tenant",
        email: "nt@nhs.net",
      });

      await expect(auth.authenticate(token)).rejects.toThrow(AuthenticationError);
      await expect(auth.authenticate(token)).rejects.toThrow("tenant_id");
    });
  });

  describe("OIDC_DEFAULT_TENANT env wiring (fail-closed posture)", () => {
    // server.ts wires `defaultTenantId: process.env['OIDC_DEFAULT_TENANT']`, so an
    // unset env var arrives as `undefined`. configure() normalizes it to null, so a
    // token without a tenant_id claim must still be rejected (fail-closed).
    it("stays fail-closed when OIDC_DEFAULT_TENANT is unset (undefined)", async () => {
      const auth = createAuthenticator({ defaultTenantId: undefined });
      const token = await signToken({
        sub: "user-env-unset",
        name: "Env Unset",
        email: "u@nhs.net",
      });
      await expect(auth.authenticate(token)).rejects.toThrow(AuthenticationError);
      await expect(auth.authenticate(token)).rejects.toThrow(
        "no default tenant is configured",
      );
    });

    it("opts into a fallback tenant when OIDC_DEFAULT_TENANT is set", async () => {
      const auth = createAuthenticator({ defaultTenantId: "default" });
      const token = await signToken({
        sub: "user-env-set",
        name: "Env Set",
        email: "s@nhs.net",
      });
      const user = await auth.authenticate(token);
      expect(user.tenantId).toBe("default");
    });
  });

  describe("CIS2 role mapping", () => {
    it("maps CIS2 role codes to platform roles", async () => {
      const auth = createAuthenticator({
        defaultTenantId: "nhs-trust-1",
        roleMapping: CIS2_ROLE_MAPPINGS,
      });

      const token = await signToken({
        sub: "cis2-user-1",
        name: "Dr. CIS2",
        email: "cis2@nhs.net",
        nhsroles: ["R8000", "R8001"],
      });

      const user = await auth.authenticate(token);
      expect(user.roles).toContain("clinician");
      expect(user.roles).toContain("nurse_in_charge");
    });

    it("maps admin CIS2 role correctly", async () => {
      const auth = createAuthenticator({
        defaultTenantId: "nhs-trust-1",
        roleMapping: CIS2_ROLE_MAPPINGS,
      });

      const token = await signToken({
        sub: "cis2-admin",
        name: "Admin CIS2",
        email: "admin-cis2@nhs.net",
        nhsroles: ["R8003"],
      });

      const user = await auth.authenticate(token);
      expect(user.roles).toEqual(["admin"]);
    });

    it("returns empty roles for unknown CIS2 codes", async () => {
      const auth = createAuthenticator({
        defaultTenantId: "nhs-trust-1",
        roleMapping: CIS2_ROLE_MAPPINGS,
      });

      const token = await signToken({
        sub: "cis2-unknown",
        name: "Unknown Role",
        email: "unknown@nhs.net",
        nhsroles: ["R9999"],
      });

      const user = await auth.authenticate(token);
      expect(user.roles).toEqual([]);
    });

    it("supports custom role mapping configuration", async () => {
      const auth = createAuthenticator({
        defaultTenantId: "custom-tenant",
        roleMapping: {
          claimName: "custom_roles",
          mappings: {
            "super_user": "admin",
            "viewer": "readonly",
          },
        },
      });

      const token = await signToken({
        sub: "custom-user",
        name: "Custom",
        email: "custom@example.com",
        custom_roles: ["super_user", "viewer"],
      });

      const user = await auth.authenticate(token);
      expect(user.roles).toContain("admin");
      expect(user.roles).toContain("readonly");
    });

    it("deduplicates mapped roles", async () => {
      const auth = createAuthenticator({
        defaultTenantId: "nhs-trust-1",
        roleMapping: CIS2_ROLE_MAPPINGS,
      });

      // R8000 and R8004 both map to "clinician"
      const token = await signToken({
        sub: "cis2-dedup",
        name: "Dedup",
        email: "dedup@nhs.net",
        nhsroles: ["R8000", "R8004"],
      });

      const user = await auth.authenticate(token);
      expect(user.roles).toEqual(["clinician"]);
    });
  });
});
