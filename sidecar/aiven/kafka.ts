/**
 * AgentCraft — Kafka consumer on `agent.coordination` (Track A / Brain, lane L2, plan §0 + §2 L2).
 *
 * The Aiven main-track is scored on a LIVE Kafka coordination signal projected into /world. Until now the
 * topic was only documented (schema.sql / coordination-prompt.md) — events in /world came purely from the
 * coord_events table SELECT. This module actually CONSUMES `agent.coordination` and folds each message
 * into the same coord_events feed the projection reads, so the live Kafka beat shows up in the world.
 *
 * DESIGN — best-effort, opt-in, NEVER hangs boot (mirrors the Aiven MCP's opt-in contract):
 *   - OFF by default. It lights up only when AIVEN_KAFKA_BROKERS (+ creds) is set — same shape as the
 *     MCP/PG opt-ins, so an unconfigured machine pays nothing and never blocks.
 *   - kafkajs is an OPTIONAL runtime dep: we `import("kafkajs")` dynamically. If it isn't installed the
 *     consumer cleanly degrades to OFF (logged once) instead of failing the typecheck or the boot — the
 *     rest of the data plane (PG projection, operator) is unaffected.
 *   - start() returns immediately; the connect/subscribe/run happens on a detached promise that can never
 *     reject into boot. A bad/unreachable broker degrades to OFF, it does not wedge startup.
 *   - each consumed message is folded into Postgres coord_events (best-effort) AND published on the local
 *     ServerEvent bus as an `aiven` event, so /world surfaces it whether the client polls /world or is on
 *     the WS stream. Postgres stays the source of truth; Kafka is the reaction signal (plan/schema rule).
 *
 * Message shape (mirrors coord_events rows): JSON `{ ts?, type, agent_id, detail? }`. Malformed/oversized
 * frames are skipped defensively — a junk payload on the bus can never crash the consumer or /world.
 *
 * TLS/SASL: Aiven Kafka requires TLS and (usually) SASL. AIVEN_KAFKA_CA points at the CA pem; SASL is
 * enabled when AIVEN_KAFKA_USERNAME/PASSWORD are set (mechanism via AIVEN_KAFKA_SASL_MECHANISM, default
 * scram-sha-256). With brokers but no creds we still require TLS (system trust store).
 */
import fsSync from "node:fs";
import { logger } from "../logger.ts";
import { metrics } from "../metrics.ts";
import { store } from "../session-store.ts";
import { queryWithRetry } from "./pg.ts";
import type { CoordEvent, ServerEvent } from "../contract.ts";

/** The coordination topic — fixed (1 partition, total order), matches schema.sql + the operator mission. */
export const COORDINATION_TOPIC = "agent.coordination";

/** Largest message we'll parse — a coordination beat is tiny; anything bigger is junk, skip it. */
const MAX_MESSAGE_BYTES = 16 * 1024;

/** Module state so start()/stop() are idempotent and we never double-connect. */
let consumer: { disconnect(): Promise<void> } | null = null;
let starting = false;
let loggedOffReason = false;

/** Comma/space-separated broker list from AIVEN_KAFKA_BROKERS, or [] when unset. */
function brokers(): string[] {
  return (process.env.AIVEN_KAFKA_BROKERS ?? "")
    .split(/[\s,]+/)
    .map((b) => b.trim())
    .filter(Boolean);
}

/** True when a Kafka broker list is configured (the consumer is meant to be ON). */
export function kafkaConfigured(): boolean {
  return brokers().length > 0;
}

/** Resolve TLS config for kafkajs the same way pg.ts resolves it (CA pem path, else system trust). */
function resolveSsl(): boolean | { ca: string[]; rejectUnauthorized: boolean } {
  // Local / dev Kafka (docker) speaks PLAINTEXT on loopback. Aiven always uses TLS, so this only ever
  // fires locally — the same code path proves the full loop on local infra before a real Aiven URL swaps in.
  if (isLocalBrokers()) return false;
  const caPath = process.env.AIVEN_KAFKA_CA?.trim();
  if (caPath) {
    try {
      return { ca: [fsSync.readFileSync(caPath, "utf8")], rejectUnauthorized: true };
    } catch (e) {
      logger.warn(`[aiven/kafka] could not read AIVEN_KAFKA_CA (${caPath}): ${msg(e)} — system trust.`);
    }
  }
  return true; // Aiven Kafka requires TLS; verify against the system trust store
}

/** True when every broker is loopback (or AIVEN_KAFKA_NO_TLS=1) — local infra, PLAINTEXT + no SASL. */
function isLocalBrokers(): boolean {
  if (process.env.AIVEN_KAFKA_NO_TLS === "1") return true;
  const bs = brokers();
  return bs.length > 0 && bs.every((b) => /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/.test(b));
}

/** Resolve SASL config, or undefined when no username/password is set (TLS-only). */
function resolveSasl():
  | { mechanism: "plain" | "scram-sha-256" | "scram-sha-512"; username: string; password: string }
  | undefined {
  const username = process.env.AIVEN_KAFKA_USERNAME?.trim();
  const password = process.env.AIVEN_KAFKA_PASSWORD?.trim();
  if (!username || !password) return undefined;
  const mech = (process.env.AIVEN_KAFKA_SASL_MECHANISM?.trim() || "scram-sha-256").toLowerCase();
  const mechanism =
    mech === "plain" || mech === "scram-sha-512" ? mech : "scram-sha-256";
  return { mechanism, username, password };
}

/**
 * Start the coordination consumer (idempotent; no-op when unconfigured). Returns immediately — the actual
 * connect/subscribe/run runs on a detached promise that can NEVER reject into the caller, so a dead broker
 * or a missing kafkajs degrades to OFF without touching boot.
 */
export function startCoordinationConsumer(): void {
  if (consumer || starting) return; // already running / starting
  if (!kafkaConfigured()) {
    if (!loggedOffReason) {
      logger.info("[aiven/kafka] no AIVEN_KAFKA_BROKERS — Kafka consumer OFF (coord_events still feed /world).");
      loggedOffReason = true;
    }
    return;
  }
  starting = true;
  // Detached: the whole connect path is fire-and-forget and self-contained so boot is never blocked
  // or crashed by Kafka. Any failure flips state back to OFF and logs once.
  void connectAndRun().catch((e) => {
    starting = false;
    consumer = null;
    logger.warn("[aiven/kafka] consumer unavailable — degraded to OFF", { error: msg(e) });
  });
}

async function connectAndRun(): Promise<void> {
  // kafkajs is an OPTIONAL dep — dynamic import so a machine without it still typechecks + boots.
  let Kafka: any;
  try {
    ({ Kafka } = await import("kafkajs"));
  } catch {
    starting = false;
    logger.info("[aiven/kafka] kafkajs not installed — Kafka consumer OFF (npm i kafkajs to enable).");
    return;
  }

  const sasl = resolveSasl();
  const kafka = new Kafka({
    clientId: "agentcraft-sidecar",
    brokers: brokers(),
    ssl: resolveSsl(),
    ...(sasl ? { sasl } : {}),
    // Bounded so an unreachable broker fails fast to OFF rather than retrying forever in the background.
    connectionTimeout: 5000,
    requestTimeout: 8000,
    retry: { retries: 2, initialRetryTime: 300 },
  });

  const c = kafka.consumer({ groupId: `agentcraft-sidecar-${process.pid}` });
  await c.connect();
  await c.subscribe({ topic: COORDINATION_TOPIC, fromBeginning: false });
  consumer = c;
  starting = false;
  metrics.setGauge("aiven_kafka_consumer_up", 1);
  logger.info("[aiven/kafka] consuming agent.coordination", { brokers: brokers().length });

  await c.run({
    eachMessage: async ({ message }: { message: { value: Buffer | null } }) => {
      // Per-message handler is fully defensive: one junk frame must never break the consumer or /world.
      try {
        await onMessage(message.value);
      } catch (e) {
        metrics.inc("aiven_kafka_message_errors");
        logger.warn("[aiven/kafka] message handler error (skipped)", { error: msg(e) });
      }
    },
  });
}

/** Parse one Kafka frame into a CoordEvent, fold it into coord_events, and publish it on the local bus. */
async function onMessage(value: Buffer | null): Promise<void> {
  if (!value) return;
  if (value.length > MAX_MESSAGE_BYTES) {
    metrics.inc("aiven_kafka_oversized_skipped");
    return;
  }
  const ev = parseCoordEvent(value.toString("utf8"));
  if (!ev) {
    metrics.inc("aiven_kafka_malformed_skipped");
    return;
  }
  metrics.inc("aiven_kafka_messages");

  // Fold into Postgres so the /world coord_events SELECT also reflects the Kafka beat (idempotency is not
  // required here — coord_events is an append-only log; a duplicate is harmless and just shows once more).
  // Best-effort: a PG hiccup must not stop us from publishing on the local bus.
  await queryWithRetry(
    `INSERT INTO world_state.coord_events (ts, type, agent_id, detail) VALUES ($1,$2,$3,$4)`,
    [ev.ts, ev.type, ev.agent_id, ev.detail],
  ).catch((e) => logger.warn("[aiven/kafka] coord_events insert failed", { error: msg(e) }));

  // Publish on the in-proc bus so WS clients see the coordination beat live (the `aiven` ServerEvent).
  const serverEvent: ServerEvent = { type: "aiven", agent_id: ev.agent_id, event: ev };
  store.publish(serverEvent);
}

/**
 * Parse + validate a coordination message. Returns null for anything malformed (not JSON, missing type/
 * agent_id, wrong types) so a junk payload is skipped rather than crashing. ts defaults to now if absent.
 */
function parseCoordEvent(raw: string): CoordEvent | null {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.type !== "string" || !obj.type) return null;
  if (typeof obj.agent_id !== "string" || !obj.agent_id) return null;
  return {
    ts: typeof obj.ts === "string" && obj.ts ? obj.ts : new Date().toISOString(),
    type: obj.type,
    agent_id: obj.agent_id,
    detail: typeof obj.detail === "string" ? obj.detail : "",
  };
}

// --------------------------------------------------------------------------------------------------
// Producer — emit coordination / activity beats to agent.coordination (the multiplayer substrate).
// --------------------------------------------------------------------------------------------------

let producer: { disconnect(): Promise<void>; send(args: unknown): Promise<unknown> } | null = null;
let producerStarting = false;

/** Lazily connect a Kafka producer (idempotent; no-op when unconfigured). Best-effort, never throws. */
export async function getProducer(): Promise<typeof producer> {
  if (producer || producerStarting || !kafkaConfigured()) return producer;
  producerStarting = true;
  try {
    const { Kafka } = await import("kafkajs");
    const sasl = resolveSasl();
    const kafka = new Kafka({
      clientId: "agentcraft-sidecar-producer",
      brokers: brokers(),
      ssl: resolveSsl(),
      ...(sasl ? { sasl } : {}),
      connectionTimeout: 5000,
      requestTimeout: 8000,
      retry: { retries: 2, initialRetryTime: 300 },
    });
    const p = kafka.producer();
    await p.connect();
    producer = p;
    logger.info("[aiven/kafka] producer connected", { brokers: brokers().length });
  } catch (e) {
    logger.warn("[aiven/kafka] producer unavailable — degraded to OFF", { error: msg(e) });
  } finally {
    producerStarting = false;
  }
  return producer;
}

/**
 * Produce one coordination/activity beat to agent.coordination. The consumer (any sidecar, incl. other
 * users in the multiplayer world) folds it into coord_events → /world. Fire-and-forget, never throws, no-op
 * when Kafka is unconfigured. This is the "agent emits → Kafka" leg of the activity loop (DATA_MODEL.md).
 */
export async function produceCoordEvent(ev: {
  type: string;
  agent_id: string;
  detail?: string;
  ts?: string;
}): Promise<void> {
  if (!kafkaConfigured()) return;
  try {
    const p = await getProducer();
    if (!p) return;
    const payload = JSON.stringify({
      ts: ev.ts ?? new Date().toISOString(),
      type: ev.type,
      agent_id: ev.agent_id,
      detail: ev.detail ?? "",
    });
    await p.send({ topic: COORDINATION_TOPIC, messages: [{ value: payload }] });
    metrics.inc("aiven_kafka_produced");
  } catch (e) {
    logger.warn("[aiven/kafka] produce failed (skipped)", { error: msg(e) });
  }
}

/** True when the consumer is connected and running. */
export function kafkaConsumerUp(): boolean {
  return consumer !== null;
}

/** Disconnect the consumer on shutdown. Best-effort, bounded — never throws. */
export async function stopCoordinationConsumer(): Promise<void> {
  const c = consumer;
  const p = producer;
  consumer = null;
  producer = null;
  starting = false;
  producerStarting = false;
  metrics.setGauge("aiven_kafka_consumer_up", 0);
  await Promise.allSettled([
    c ? c.disconnect() : Promise.resolve(),
    p ? p.disconnect() : Promise.resolve(),
  ]).catch(() => {});
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
