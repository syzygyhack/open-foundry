#!/usr/bin/env bash
# Open Foundry — Development Environment Setup
# Waits for infrastructure and initializes all dependent services.
# Runs psql via `docker compose exec` so no host-side pg tools are needed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yaml"

# Load env file if present
if [ -f "${SCRIPT_DIR}/.env" ]; then
  set -a; source "${SCRIPT_DIR}/.env"; set +a
fi

POSTGRES_DB="${POSTGRES_DB:-openfoundry}"
POSTGRES_USER="${POSTGRES_USER:-openfoundry}"
OPENFGA_HOST="${OPENFGA_HOST:-localhost}"
OPENFGA_PORT="${OPENFGA_PORT:-8280}"

log() { echo "[init] $*"; }
err() { echo "[init] ERROR: $*" >&2; }

# Run psql inside the postgresql container (no host-side pg tools required).
dc_psql() {
  docker compose -f "${COMPOSE_FILE}" exec -T postgresql \
    psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -q "$@"
}

# ─── 1. Wait for PostgreSQL ────────────────────────────────────────

wait_for_postgres() {
  log "Waiting for PostgreSQL (via docker compose exec)..."
  local attempts=0
  local max_attempts=30
  until docker compose -f "${COMPOSE_FILE}" exec -T postgresql \
    pg_isready -U "${POSTGRES_USER}" -q 2>/dev/null; do
    attempts=$((attempts + 1))
    if [ "${attempts}" -ge "${max_attempts}" ]; then
      err "PostgreSQL not ready after ${max_attempts} attempts"
      exit 1
    fi
    sleep 2
  done
  log "PostgreSQL is ready."
}

# ─── 2. Initialize Apache AGE extension ────────────────────────────

init_age() {
  log "Initializing Apache AGE extension..."
  dc_psql <<'SQL'
CREATE EXTENSION IF NOT EXISTS age;
LOAD 'age';
SET search_path = ag_catalog, "$user", public;
SELECT create_graph('openfoundry') WHERE NOT EXISTS (
  SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'openfoundry'
);
SQL
  log "AGE extension initialized."
}

# ─── 3. Wait for OpenFGA ──────────────────────────────────────────

wait_for_openfga() {
  log "Waiting for OpenFGA on ${OPENFGA_HOST}:${OPENFGA_PORT}..."
  local attempts=0
  local max_attempts=30
  until curl -sf "http://${OPENFGA_HOST}:${OPENFGA_PORT}/healthz" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "${attempts}" -ge "${max_attempts}" ]; then
      err "OpenFGA not ready after ${max_attempts} attempts"
      exit 1
    fi
    sleep 2
  done
  log "OpenFGA is ready."
}

# ─── 4. Load OpenFGA authorization model ──────────────────────────

load_openfga_model() {
  log "Creating OpenFGA store and loading authorization model..."

  # Create store
  local store_response
  store_response=$(curl -sf -X POST "http://${OPENFGA_HOST}:${OPENFGA_PORT}/stores" \
    -H "Content-Type: application/json" \
    -d '{"name": "openfoundry"}')

  local store_id
  store_id=$(echo "${store_response}" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -z "${store_id}" ]; then
    # Store may already exist — list stores and find it
    local list_response
    list_response=$(curl -sf "http://${OPENFGA_HOST}:${OPENFGA_PORT}/stores")
    store_id=$(echo "${list_response}" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  fi

  if [ -z "${store_id}" ]; then
    err "Failed to create or find OpenFGA store"
    exit 1
  fi

  log "OpenFGA store ID: ${store_id}"

  # Write authorization model
  local model_file="${SCRIPT_DIR}/openfga-model.json"
  if [ ! -f "${model_file}" ]; then
    err "OpenFGA model file not found: ${model_file}"
    exit 1
  fi

  curl -sf -X POST "http://${OPENFGA_HOST}:${OPENFGA_PORT}/stores/${store_id}/authorization-models" \
    -H "Content-Type: application/json" \
    -d @"${model_file}" >/dev/null

  log "OpenFGA model loaded. Store ID: ${store_id}"

  # Persist the store ID into .env so services pick it up on restart
  local env_file="${SCRIPT_DIR}/.env"
  if [ -f "${env_file}" ]; then
    if grep -q '^OPENFGA_STORE_ID=' "${env_file}"; then
      # Portable edit (BSD sed's -i takes a suffix argument). The new file is
      # staged beside .env (mktemp creates it 0600; .env holds passwords),
      # filled, given .env's own mode (GNU or BSD stat; it stays 0600 if
      # neither answers), and renamed over .env only once complete (mv -f: a
      # read-only .env would otherwise prompt on a terminal), so a failure
      # leaves .env as it was.
      local tmp="" mode=""
      mode=$(stat -c %a "${env_file}" 2>/dev/null || stat -f %Lp "${env_file}" 2>/dev/null || true)
      if ! tmp=$(mktemp "${env_file}.XXXXXX") \
        || ! sed "s/^OPENFGA_STORE_ID=.*/OPENFGA_STORE_ID=${store_id}/" "${env_file}" > "${tmp}" \
        || { [ -n "${mode}" ] && ! chmod "${mode}" "${tmp}"; } \
        || ! mv -f "${tmp}" "${env_file}"; then
        if [ -n "${tmp}" ]; then rm -f "${tmp}"; fi
        err "Could not update ${env_file} (left unchanged); set OPENFGA_STORE_ID=${store_id} manually."
        return 1
      fi
    elif ! echo "OPENFGA_STORE_ID=${store_id}" >> "${env_file}"; then
      err "Could not update ${env_file}; set OPENFGA_STORE_ID=${store_id} manually."
      return 1
    fi
    log "Wrote OPENFGA_STORE_ID=${store_id} to ${env_file}"
  else
    log "No .env file found — set OPENFGA_STORE_ID=${store_id} manually."
  fi
}

# ─── 5. Create domain pack registry tables ────────────────────────

load_domain_schema() {
  log "Creating domain pack registry tables..."

  # Create core tables for the domain pack registry.
  # The api-gateway registers all loaded packs on boot via INSERT ... ON CONFLICT.
  dc_psql <<'SQL'
-- Domain pack registry
CREATE TABLE IF NOT EXISTS _domain_packs (
  name        TEXT PRIMARY KEY,
  version     TEXT NOT NULL,
  namespace   TEXT NOT NULL,
  loaded_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Object type registry
CREATE TABLE IF NOT EXISTS _object_types (
  pack_name   TEXT REFERENCES _domain_packs(name),
  type_name   TEXT NOT NULL,
  namespace   TEXT NOT NULL,
  definition  JSONB NOT NULL,
  PRIMARY KEY (pack_name, type_name)
);

-- Link type registry
CREATE TABLE IF NOT EXISTS _link_types (
  pack_name   TEXT REFERENCES _domain_packs(name),
  type_name   TEXT NOT NULL,
  namespace   TEXT NOT NULL,
  definition  JSONB NOT NULL,
  PRIMARY KEY (pack_name, type_name)
);

-- Audit log table
CREATE TABLE IF NOT EXISTS _audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp   TIMESTAMPTZ DEFAULT NOW(),
  actor_id    TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  resource    TEXT NOT NULL,
  resource_id TEXT,
  details     JSONB
);
SQL

  log "Domain pack registry tables created."
}

# ─── Main ─────────────────────────────────────────────────────────

main() {
  log "Starting Open Foundry development environment setup..."
  log ""

  wait_for_postgres
  init_age
  wait_for_openfga
  load_openfga_model
  load_domain_schema

  log ""
  log "Setup complete."
  log ""
  log "Services:"
  log "  GraphQL Playground: http://localhost:4000/graphql"
  log "  Keycloak Admin:     http://localhost:8180/auth/admin"
  log "  OpenFGA Playground: http://localhost:8280/playground"
  log "  Debezium:           http://localhost:8083/"
  log "  OTEL Collector:     http://localhost:4318 (OTLP/HTTP, used by the services), :4317 (gRPC)"
}

main "$@"
