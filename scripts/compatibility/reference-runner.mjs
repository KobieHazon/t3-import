// Copied into a pinned source snapshot by prepare.mjs so package imports resolve
// to that snapshot's contracts and matching Effect runtime.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeSqlitePersistenceLive } from "./apps/server/src/persistence/Layers/Sqlite.ts";
import { ServerConfig } from "./apps/server/src/config.ts";
import { OrchestrationProjectionPipelineLive } from "./apps/server/src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "./apps/server/src/orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "./apps/server/src/persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "./apps/server/src/persistence/Services/OrchestrationEventStore.ts";
import { ProviderSessionDirectoryLive } from "./apps/server/src/provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "./apps/server/src/provider/Services/ProviderSessionDirectory.ts";

const [action, homeArg, output] = process.argv.slice(2);
const home = resolve(homeArg);
// Only a caller-created synthetic home is eligible for writes/migrations.
assert(existsSync(resolve(home, ".compatibility-fixture")), "Missing isolated fixture marker");
const dbPath = resolve(home, "userdata/state.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
const runtimeModule = existsSync(new URL("./apps/server/src/persistence/ProviderSessionRuntime.ts", import.meta.url))
  ? await import("./apps/server/src/persistence/ProviderSessionRuntime.ts")
  : await import("./apps/server/src/persistence/Layers/ProviderSessionRuntime.ts");
const runtimeLayer = runtimeModule.layer ?? runtimeModule.ProviderSessionRuntimeRepositoryLive;
const sqlLayer = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
const dependencies = Layer.mergeAll(
  OrchestrationEventStoreLive,
  ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeLayer)),
).pipe(Layer.provideMerge(sqlLayer));
const testLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(dependencies),
  Layer.provideMerge(ServerConfig.layerTest(home, home)),
  Layer.provideMerge(NodeServices.layer),
);

await Effect.runPromise(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (action === "schema") {
    const rows = yield* sql`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name`;
    const migrations = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    writeFileSync(output, JSON.stringify({ ddl: rows.map((row) => row.sql), migrations }, null, 2) + "\n");
  } else if (action === "project" || action === "resume") {
    const store = yield* OrchestrationEventStore;
    // Exercise the reference's persisted-event decoder before projecting.
    const events = yield* Stream.runCollect(store.readFromSequence(0, Number.MAX_SAFE_INTEGER));
    const pipeline = yield* OrchestrationProjectionPipeline;
    yield* pipeline.bootstrap;
    const directory = yield* ProviderSessionDirectory;
    const rows = yield* sql`SELECT thread_id FROM provider_session_runtime`;
    const bindings = [];
    for (const row of rows) {
      const binding = yield* directory.getBinding(row.thread_id);
      assert(Option.isSome(binding), `Missing restored binding ${row.thread_id}`);
      bindings.push(binding.value);
    }
    const resumed = action === "resume" ? yield* awaitResume(bindings) : undefined;
    if (resumed) {
      // Persist a controlled provider continuation using T3's real event store.
      // These IDs are native (not the importer's deterministic event IDs).
      for (const binding of bindings) {
        const threadId = binding.threadId;
        const turnId = "controlled-resume-turn";
        const startedAt = "2026-01-05T00:00:00.000Z";
        const completedAt = "2026-01-05T00:00:03.000Z";
        const selection = binding.runtimePayload.modelSelection;
        const payloads = [
          ["thread.message-sent", { threadId, messageId: "native-user-5", role: "user", text: "Question 5", attachments: [], turnId: null, streaming: false, createdAt: startedAt, updatedAt: startedAt }],
          ["thread.turn-start-requested", { threadId, messageId: "native-user-5", modelSelection: selection, runtimeMode: binding.runtimeMode, interactionMode: "default", createdAt: startedAt }],
          ["thread.session-set", { threadId, session: { threadId, status: "running", providerName: binding.provider, providerInstanceId: binding.providerInstanceId, runtimeMode: binding.runtimeMode, activeTurnId: turnId, lastError: null, updatedAt: startedAt } }],
          ["thread.message-sent", { threadId, messageId: "native-assistant-5", role: "assistant", text: "Answer 5", turnId, streaming: false, createdAt: completedAt, updatedAt: completedAt }],
          ["thread.session-set", { threadId, session: { threadId, status: "ready", providerName: binding.provider, providerInstanceId: binding.providerInstanceId, runtimeMode: binding.runtimeMode, activeTurnId: null, lastError: null, updatedAt: completedAt } }],
        ];
        for (const [type, payload] of payloads) {
          const event = yield* store.append({ type, eventId: randomUUID(), aggregateKind: "thread", aggregateId: threadId,
            occurredAt: payload.updatedAt ?? payload.createdAt ?? payload.session.updatedAt,
            commandId: null, causationEventId: null, correlationId: null,
            metadata: { adapterKey: binding.adapterKey, providerTurnId: turnId }, payload });
          // Live T3 projects each continuation event as it arrives.
          yield* pipeline.projectEvent(event);
        }
      }
    }
    writeFileSync(output, JSON.stringify({ events: Array.from(events).length, bindings, resumed }, null, 2) + "\n");
  } else {
    assert.equal(action, "migrate");
  }
}).pipe(Effect.provide(testLayer)));

function awaitResume(bindings) {
  return Effect.promise(() => import("./resume.mjs")).pipe(Effect.flatMap((module) => module.resumeBindings(bindings)));
}
