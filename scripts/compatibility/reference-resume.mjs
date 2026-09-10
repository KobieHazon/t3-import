import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makeProviderServiceLive } from "./apps/server/src/provider/Layers/ProviderService.ts";
import { ProviderService } from "./apps/server/src/provider/Services/ProviderService.ts";
import { ProviderAdapterRegistry } from "./apps/server/src/provider/Services/ProviderAdapterRegistry.ts";
import { makeAdapterRegistryMock } from "./apps/server/src/provider/testUtils/providerAdapterRegistryMock.ts";
import * as Analytics from "./apps/server/src/telemetry/AnalyticsService.ts";
import * as Loggers from "./apps/server/src/provider/Layers/ProviderEventLoggers.ts";
import * as Settings from "./apps/server/src/serverSettings.ts";

// Only the process-facing adapters are doubled. T3's real ProviderService must
// restore the persisted binding and route it to the correct provider instance.
export function resumeBindings(bindings) {
  const starts = [];
  const turns = [];
  const adapters = {};
  for (const binding of bindings) {
    const sessions = new Map();
    adapters[binding.provider] = {
      provider: binding.provider,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession: (input) => Effect.sync(() => {
        assert.deepEqual(input.resumeCursor, binding.resumeCursor);
        assert.equal(input.cwd, binding.runtimePayload.cwd);
        assert.equal(input.providerInstanceId, binding.providerInstanceId);
        starts.push(input);
        const session = { ...input, provider: binding.provider, status: "ready", createdAt: "2026-01-10T00:00:00.000Z", updatedAt: "2026-01-10T00:00:00.000Z" };
        sessions.set(input.threadId, session);
        return session;
      }),
      sendTurn: (input) => Effect.sync(() => {
        assert(sessions.has(input.threadId));
        turns.push(input);
        return { threadId: input.threadId, turnId: "controlled-resume-turn" };
      }),
      hasSession: (id) => Effect.succeed(sessions.has(id)),
      listSessions: () => Effect.succeed([...sessions.values()]),
      stopSession: (id) => Effect.sync(() => { sessions.delete(id); }),
      stopAll: () => Effect.sync(() => { sessions.clear(); }),
      streamEvents: Stream.empty,
    };
  }
  const defaults = makeAdapterRegistryMock(adapters);
  const registry = {
    ...defaults,
    listInstances: () => Effect.succeed(bindings.map((binding) => binding.providerInstanceId)),
    getByInstance: (id) => {
      const binding = bindings.find((entry) => entry.providerInstanceId === id);
      assert(binding, `Unexpected adapter ${id}`);
      return Effect.succeed(adapters[binding.provider]);
    },
    getInstanceInfo: (id) => {
      const binding = bindings.find((entry) => entry.providerInstanceId === id);
      assert(binding);
      return defaults.getInstanceInfo(binding.provider).pipe(Effect.map((info) => ({ ...info, instanceId: id })));
    },
  };
  const layer = makeProviderServiceLive().pipe(
    Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
    Layer.provide(Analytics.layerTest),
    Layer.provide(Layer.succeed(Loggers.ProviderEventLoggers, Loggers.NoOpProviderEventLoggers)),
    Layer.provide(Settings.layerTest ? Settings.layerTest() : Settings.ServerSettingsService.layerTest()),
  );
  return Effect.gen(function* () {
    const provider = yield* ProviderService;
    for (const binding of bindings) {
      yield* provider.startSession(binding.threadId, {
        threadId: binding.threadId, provider: binding.provider, providerInstanceId: binding.providerInstanceId,
        runtimeMode: binding.runtimeMode, modelSelection: binding.runtimePayload.modelSelection,
        // Deliberately omit cwd and resumeCursor: the persisted row must supply them.
      });
      const result = yield* provider.sendTurn({ threadId: binding.threadId, input: "Controlled continuation", attachments: [] });
      assert.equal(result.threadId, binding.threadId);
    }
    assert.equal(starts.length, bindings.length);
    assert.equal(turns.length, bindings.length);
    return { starts, turns };
  }).pipe(Effect.provide(layer));
}
