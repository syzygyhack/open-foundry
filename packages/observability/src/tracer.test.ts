import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  trace,
  SpanStatusCode,
  context as otelContext,
} from "@opentelemetry/api";
import {
  TracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { getTracer, withSpan, getActiveSpan, SpanAttributes } from "./tracer.js";

describe("tracer", () => {
  let exporter: InMemorySpanExporter;
  let provider: TracerProvider;
  let contextManager: AsyncLocalStorageContextManager;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    // OTEL JS 3.x: sdk-trace-base became sdk-trace, BasicTracerProvider became
    // TracerProvider, and span processors take an options object rather than
    // a bare exporter. As in 2.x, span processors are supplied via the
    // constructor and there is no provider.register(), so the provider and
    // context manager are registered on the global API explicitly.
    provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    });
    otelContext.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    contextManager.disable();
    trace.disable();
    otelContext.disable();
  });

  describe("getTracer", () => {
    it("creates a tracer with openfoundry.<layer>.<operation> naming", () => {
      const tracer = getTracer("engine", "query");
      expect(tracer).toBeDefined();
      // Verify the tracer works by creating a span
      tracer.startActiveSpan("test-span", (span) => {
        span.end();
      });
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      // The instrumentation scope name follows our convention
      // (OTEL JS 2.x renamed instrumentationLibrary -> instrumentationScope).
      expect(spans[0]!.instrumentationScope.name).toBe(
        "openfoundry.engine.query",
      );
    });

    it("supports all valid layer types", () => {
      const layers = [
        "engine",
        "action",
        "security",
        "sync",
        "computed",
        "api",
        "domain",
      ] as const;

      for (const layer of layers) {
        const tracer = getTracer(layer, "test");
        tracer.startActiveSpan("span", (span) => {
          span.end();
        });
      }

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(layers.length);

      const names = spans.map((s) => s.instrumentationScope.name);
      for (const layer of layers) {
        expect(names).toContain(`openfoundry.${layer}.test`);
      }
    });
  });

  describe("withSpan", () => {
    it("creates a span with standard attributes", () => {
      const tracer = getTracer("engine", "crud");

      const result = withSpan(
        tracer,
        "create-record",
        {
          [SpanAttributes.OBJECT_TYPE]: "Patient",
          [SpanAttributes.OBJECT_ID]: "patient-123",
          [SpanAttributes.TENANT_ID]: "nhs-trust-1",
          [SpanAttributes.OPERATION]: "create",
        },
        (_span) => "done",
      );

      expect(result).toBe("done");

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);

      const span = spans[0]!;
      expect(span.name).toBe("create-record");
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.attributes["object.type"]).toBe("Patient");
      expect(span.attributes["object.id"]).toBe("patient-123");
      expect(span.attributes["tenant.id"]).toBe("nhs-trust-1");
      expect(span.attributes["operation"]).toBe("create");
    });

    it("records error status on thrown exceptions", () => {
      const tracer = getTracer("engine", "crud");

      expect(() =>
        withSpan(tracer, "failing-op", {}, () => {
          throw new Error("test error");
        }),
      ).toThrow("test error");

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);

      const span = spans[0]!;
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe("test error");
      expect(span.events).toHaveLength(1);
      expect(span.events[0]!.name).toBe("exception");
    });

    it("handles async functions", async () => {
      const tracer = getTracer("action", "webhook");

      const result = await withSpan(
        tracer,
        "async-op",
        { [SpanAttributes.OPERATION]: "send" },
        async (_span) => {
          return "async-done";
        },
      );

      expect(result).toBe("async-done");

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.status.code).toBe(SpanStatusCode.OK);
    });

    it("records error status on async rejection", async () => {
      const tracer = getTracer("action", "webhook");

      await expect(
        withSpan(tracer, "async-fail", {}, async () => {
          throw new Error("async error");
        }),
      ).rejects.toThrow("async error");

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    });
  });

  describe("getActiveSpan", () => {
    it("returns undefined when no active span", () => {
      expect(getActiveSpan()).toBeUndefined();
    });

    it("returns the span set via context API", () => {
      const tracer = getTracer("engine", "test");
      const span = tracer.startSpan("manual-span");
      const ctxWithSpan = trace.setSpan(
        otelContext.active(),
        span,
      );
      otelContext.with(ctxWithSpan, () => {
        const active = getActiveSpan();
        expect(active).toBeDefined();
        expect(active).toBe(span);
      });
      span.end();
    });
  });

  describe("SpanAttributes", () => {
    it("has the expected attribute keys", () => {
      expect(SpanAttributes.OBJECT_TYPE).toBe("object.type");
      expect(SpanAttributes.OBJECT_ID).toBe("object.id");
      expect(SpanAttributes.TENANT_ID).toBe("tenant.id");
      expect(SpanAttributes.USER_ID).toBe("user.id");
      expect(SpanAttributes.OPERATION).toBe("operation");
    });
  });
});
