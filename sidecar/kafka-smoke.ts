/**
 * AgentCraft — Kafka activity-loop smoke (Track A / Brain, DATA_MODEL.md "Activity → shared world").
 *
 * Proves the multiplayer substrate end-to-end on REAL infra: an anonymized activity beat is PRODUCED to
 * the Kafka topic `agent.coordination`, the consumer CONSUMES it and folds it into Postgres
 * `world_state.coord_events`, and we READ IT BACK. That's "agent emits → Kafka → Postgres → read back".
 *
 * Needs a reachable Kafka broker (AIVEN_KAFKA_BROKERS) AND Postgres (AIVEN_PG_URI). Run (local):
 *   AIVEN_PG_URI='postgres://postgres:summercraft@localhost:5433/summercraft' \
 *   AIVEN_KAFKA_BROKERS='localhost:9092' \
 *   npx tsx kafka-smoke.ts
 * Exit 0 = PASS (or clean SKIP when unconfigured). Exit 1 = a real assertion failed. Real Aiven Kafka is
 * the same code path — just a broker list + TLS/SASL creds instead of localhost.
 */
import { initPg, applySchema, getPg, closePg, type PgLike } from "./aiven/pg.ts";
import {
  startCoordinationConsumer,
  stopCoordinationConsumer,
  produceCoordEvent,
  kafkaConsumerUp,
} from "./aiven/kafka.ts";

let failures = 0;
function ok(cond: boolean, label: string): void {
  if (cond) console.log("  ✓ " + label);
  else {
    console.error("  ✗ " + label);
    failures++;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let skipped = false;

async function main(): Promise<void> {
  if (!process.env.AIVEN_KAFKA_BROKERS || (!process.env.AIVEN_PG_URI && !process.env.DATABASE_URL)) {
    skipped = true;
    console.log("SKIP: set AIVEN_KAFKA_BROKERS + AIVEN_PG_URI to run the Kafka activity-loop smoke.");
    return;
  }
  initPg();
  await applySchema(); // ensures world_state.coord_events exists
  const pg = getPg() as PgLike | null;
  ok(!!pg, "Postgres connected + schema up");
  if (!pg) return;

  const marker = "kafka_smoke_" + Date.now();
  const agent = "ksmoke_agent";
  await pg.query("DELETE FROM world_state.coord_events WHERE detail LIKE 'kafka_smoke_%'").catch(() => {});

  // Consumer first (fromBeginning:false → it must be subscribed before we produce), then settle the group.
  startCoordinationConsumer();
  for (let i = 0; i < 30 && !kafkaConsumerUp(); i++) await sleep(500);
  ok(kafkaConsumerUp(), "consumer connected + subscribed to agent.coordination");
  await sleep(2000);
  console.log("producing activity beats while polling (re-produce covers the consumer-group join race)");

  // PRODUCE + POLL together. With fromBeginning:false, a message produced before the consumer group has
  // finished joining (real Aiven took ~5.5s) is missed — so we re-produce every couple seconds while we
  // poll Postgres for the fold. Idempotent for the test: we just need ONE marked row to round-trip.
  let row: { type: string; agent_id: string; detail: string } | null = null;
  for (let i = 0; i < 50; i++) {
    if (i % 4 === 0) {
      await produceCoordEvent({ type: "activity", agent_id: agent, detail: marker + " mag=3" });
    }
    const { rows } = await pg.query(
      "SELECT type, agent_id, detail FROM world_state.coord_events WHERE detail LIKE $1 ORDER BY id DESC LIMIT 1",
      [marker + "%"],
    );
    if (rows.length) {
      row = rows[0];
      break;
    }
    await sleep(500);
  }
  ok(!!row, "activity beat round-tripped: Kafka → consumer → Postgres coord_events");
  ok(!!row && row.type === "activity", "folded with type=activity (got: " + (row && row.type) + ")");
  ok(!!row && row.agent_id === agent, "agent_id preserved through the loop");
  ok(!!row && row.detail.startsWith(marker), "payload (level_path/magnitude) preserved");

  await pg.query("DELETE FROM world_state.coord_events WHERE detail LIKE 'kafka_smoke_%'").catch(() => {});
}

main()
  .catch((e) => {
    console.error("kafka-smoke crashed:", e?.message ?? e);
    failures++;
  })
  .finally(async () => {
    await stopCoordinationConsumer();
    await closePg();
    if (skipped) {
      console.log("\nKAFKA_SMOKE_SKIP — no AIVEN_KAFKA_BROKERS/AIVEN_PG_URI; nothing to verify (this is OK).");
      process.exit(0);
    } else if (failures === 0) {
      console.log("\nKAFKA_SMOKE_OK — activity emitted → Kafka → consumer → Postgres → read back.");
      process.exit(0);
    } else {
      console.error(`\nKAFKA_SMOKE_FAIL — ${failures} assertion(s) failed.`);
      process.exit(1);
    }
  });
