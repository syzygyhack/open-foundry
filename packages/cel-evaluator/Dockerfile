# Build stage
# Pinned to a patch release so the baked Go stdlib stays ahead of known CVEs
# (>=1.25.11 fixes CVE-2026-42504; >=1.25.12 the os.Root symlink flaw; >=1.25.13
# CVE-2026-33818); bump deliberately, not via a floating tag.
FROM golang:1.25.13-alpine AS builder

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
# its pinned transitive deps (v0.4.53 still ships grpc 1.81.1 —
# GHSA-hrxh-6v49-42gf) with no way for us to override them. Inside a module we
# can require the patched grpc explicitly; MVS then selects it for the build.
# Keep the grpc version here in step with the one in go.mod.
RUN mkdir -p /tools && cd /tools \
    && go mod init tools \
    && GOFLAGS=-mod=mod go get github.com/grpc-ecosystem/grpc-health-probe@v0.4.53 \
    && GOFLAGS=-mod=mod go get google.golang.org/grpc@v1.82.1 \
    && GOFLAGS=-mod=mod go get golang.org/x/text@v0.39.0 \
    && GOFLAGS=-mod=mod go get golang.org/x/net@v0.56.0 \
    && GOFLAGS=-mod=mod CGO_ENABLED=0 GOOS=linux go build -o /usr/local/bin/grpc-health-probe \
       github.com/grpc-ecosystem/grpc-health-probe

# Runtime stage
FROM alpine:3.24

ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision="${GIT_REVISION}"
ENV GIT_REVISION="${GIT_REVISION}"

RUN apk --no-cache add ca-certificates \
    && adduser -D -u 1000 cel

COPY --from=builder /usr/local/bin/grpc-health-probe /usr/local/bin/grpc-health-probe
COPY --from=builder /cel-evaluator /usr/local/bin/cel-evaluator

USER cel

EXPOSE 50051

ENTRYPOINT ["cel-evaluator"]
