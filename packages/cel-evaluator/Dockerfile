# Build stage
# Pin the patched toolchain so the compiled Go stdlib is reproducible and does
# not depend on a moving tag. go.mod previously held the language version a
# release behind the builder on purpose; taking the patched x/net (with x/sys
# and x/text alongside it) forced that to move, because those releases require
# the newer language version and the module will not build without it.
# 1.27.2 clears CVE-2026-78667 (net/http) and CVE-2026-97031 (crypto/tls),
# which the image scan reports against the stdlib linked into this binary.
# Neither looks reachable as built: this service does not import net/http and
# never calls the affected ServeContent/ServeFile helpers — grpc-go serves its
# own HTTP/2 rather than going through net/http — and both server and client are
# plaintext, so the TLS path is not entered either. The bump is scanner
# remediation and defence in depth, not a fix for an exploitable path.
FROM golang:1.27.2-alpine AS builder

WORKDIR /app

# Cache dependency downloads
COPY go.mod go.sum ./
RUN go mod download

# Copy source and build the server + the gRPC health probe. Both are compiled
# in the builder (which has the Go toolchain); only the resulting static
# binaries are copied into the runtime image — never the toolchain itself
# (copying /usr/local/go added ~400MB to the final image as a permanent layer).
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /cel-evaluator .

# grpc-health-probe is built from a throwaway module rather than
# `go install pkg@version`, which would resolve the TOOL's own go.mod and bake
# its pinned transitive deps (v0.4.53 still ships an older grpc —
# GHSA-hrxh-6v49-42gf) with no way for us to override them. Inside a module we
# can require the patched grpc explicitly; MVS then selects it for the build.
# Keep the grpc version here in step with the one in go.mod.
RUN mkdir -p /tools && cd /tools \
    && go mod init tools \
    && GOFLAGS=-mod=mod go get github.com/grpc-ecosystem/grpc-health-probe@v0.4.53 \
    && GOFLAGS=-mod=mod go get google.golang.org/grpc@v1.83.2 \
    && GOFLAGS=-mod=mod go get golang.org/x/text@v0.42.0 \
    && GOFLAGS=-mod=mod go get golang.org/x/net@v0.60.0 \
    && GOFLAGS=-mod=mod CGO_ENABLED=0 GOOS=linux go build -o /usr/local/bin/grpc-health-probe \
       github.com/grpc-ecosystem/grpc-health-probe

# Runtime stage
FROM alpine:3.24

ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision="${GIT_REVISION}"
ENV GIT_REVISION="${GIT_REVISION}"

# `apk upgrade` before installing: the alpine:3.24 tag is only rebuilt
# periodically, so a base-image CVE stays present until it is. Upgrading against
# the current package index closes that window at build time — this is how
# CVE-2026-14456 (openssl DoS, libcrypto3/libssl3 3.5.7-r0 -> 3.5.8-r0) reached
# the runtime image. The node-based service images are unaffected; only this one
# uses a bare alpine base.
RUN apk --no-cache upgrade \
    && apk --no-cache add ca-certificates \
    && adduser -D -u 1000 cel

COPY --from=builder /usr/local/bin/grpc-health-probe /usr/local/bin/grpc-health-probe
COPY --from=builder /cel-evaluator /usr/local/bin/cel-evaluator

USER cel

EXPOSE 50051

ENTRYPOINT ["cel-evaluator"]
