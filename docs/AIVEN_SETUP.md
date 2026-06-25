# Aiven setup

Aiven is what turns your local world into one that *persists* — and, eventually, one you can *share*.

You don't need any of this to play solo. If you're flying single-player, close this tab and go have fun.
Come back when you want a world that remembers itself, an activity stream, the in-world data engineer, or
multiplayer.

Here's what each piece does:

| Piece | What it's for |
|---|---|
| **Aiven for PostgreSQL** | the persistent world — hierarchy, presence, locks, activity |
| **Aiven for Apache Kafka** | the activity stream that flows between worlds (the multiplayer substrate) |
| **Aiven MCP** | lets an agent actually *run* the infra — SQL, Kafka, metrics, provisioning |

Good news: you can prove the whole thing on free local Docker first, then swap in real Aiven with zero
code changes. It's a config swap, nothing more.

---

## Never used Aiven? The 10-minute version (click by click)

You have an account — that's the hard part done. Here's literally what to click. You'll end up with a few
values that go in `sidecar/.env`. Don't overthink it; the free/Hobbyist plans are fine.

### Step 1 — make a Postgres (the world's memory)
1. In the [Aiven Console](https://console.aiven.io), click **Create service**.
2. Pick **PostgreSQL** → cheapest plan (Hobbyist/Free) → any cloud + region near you → **Create**.
3. Wait ~2 minutes for it to go green ("Running").
4. On its **Overview** page, find **Connection information**:
   - copy the **Service URI** (starts with `postgres://`) → that's your `AIVEN_PG_URI`.
   - click **Download** next to the **CA Certificate**, save it somewhere → that's your `AIVEN_PG_CA`.

### Step 2 — make a Kafka (the activity stream)
1. **Create service** → **Apache Kafka** → cheapest plan → **Create**. Wait for green.
2. On its **Overview**, find the **Service URI** / bootstrap address (`host:port`) → that's
   `AIVEN_KAFKA_BROKERS`.
3. Turn on auth: open the service → **Users** (or Authentication) → make sure **SASL** is enabled, then
   copy the **username** and **password** shown → `AIVEN_KAFKA_USERNAME` / `AIVEN_KAFKA_PASSWORD`.
4. Download that service's **CA Certificate** too → `AIVEN_KAFKA_CA`.

### Step 3 — make an API token (only if you want the in-world data engineer)
1. Top-right avatar → **Tokens** (or **Authentication tokens**) → **Generate token**.
2. Copy it once (you can't see it again) → that's your `AIVEN_TOKEN`.
3. Also note your **project name** (top-left switcher) → `AIVEN_PROJECT`.

   Skip Step 3 entirely if you just want the world to persist + multiplayer; you only need the token for
   the Ada data-operator feature.

### Step 4 — paste them into `sidecar/.env`
Make a file at `sidecar/.env` with the values you collected (it's gitignored, so it never gets committed):
```sh
AIVEN_PG_URI=postgres://...        # from Step 1
AIVEN_PG_CA=/path/to/pg-ca.pem     # the file you downloaded in Step 1
AIVEN_KAFKA_BROKERS=host:port      # from Step 2
AIVEN_KAFKA_USERNAME=...           # from Step 2
AIVEN_KAFKA_PASSWORD=...           # from Step 2
AIVEN_KAFKA_CA=/path/to/kafka-ca.pem
AIVEN_TOKEN=...                    # from Step 3 (optional)
AIVEN_PROJECT=your-project-name    # from Step 3 (optional)
```

That's it. Tell me it's there and I'll run the smokes against your real services — same code that already
passed on local Docker. If you want the precise field-by-field reference, it's below.

---

## Option A: local infra (free, great for hacking)

Run Postgres and a Kafka-compatible broker on your machine. The same code path lights up — this is
exactly how the project's own smokes are checked.

```sh
# Postgres
docker run -d --name sc-pg -e POSTGRES_PASSWORD=summercraft -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=summercraft -p 5433:5432 postgres:16-alpine

# Kafka API, via Redpanda (no JVM, boots in seconds, speaks the Kafka protocol)
docker run -d --name sc-kafka -p 9092:9092 redpandadata/redpanda:latest \
  redpanda start --mode dev-container --smp 1 \
  --kafka-addr PLAINTEXT://0.0.0.0:9092 --advertise-kafka-addr PLAINTEXT://localhost:9092
```

Point the sidecar at them — loopback hosts skip TLS automatically, so there's nothing else to configure:

```sh
# in sidecar/.env
AIVEN_PG_URI=postgres://postgres:summercraft@localhost:5433/summercraft
AIVEN_KAFKA_BROKERS=localhost:9092
```

Done with it? `docker rm -f sc-pg sc-kafka`.

## Option B: real Aiven (persistent / multiplayer)

Three things to grab from the [Aiven Console](https://console.aiven.io). Takes about ten minutes.

### 1. An API token (this powers the in-world data engineer)

Console → **Tokens** → create one. This single token is all the Aiven MCP needs — with it, an agent can
run SQL, produce and read Kafka, deploy extensions, pull metrics and logs, the works. Jot down your
**project name** while you're there.

### 2. A PostgreSQL service (the world's memory)

Spin one up — the Hobbyist plan is plenty to start. From the service **Overview**, grab:

- the **Service URI** (`postgres://avnadmin:...@....aivencloud.com:.../defaultdb?sslmode=require`)
- the **CA certificate** (`ca.pem` — there's a download button)

### 3. A Kafka service (the activity stream)

Spin one up, then:

- copy the **bootstrap brokers** (`host:port`)
- turn on **SASL** auth (SCRAM), add a user → note the **username** and **password**
- download the **CA certificate**
- optional: pre-create the `agent.coordination` topic (1 partition). If you don't, it auto-creates.

### Wire it together

Drop it all into `sidecar/.env` (which is gitignored — see [keeping secrets safe](#keeping-secrets-safe)):

```sh
# Postgres — the sidecar's direct read/write to the world
AIVEN_PG_URI=postgres://avnadmin:...@....aivencloud.com:.../defaultdb?sslmode=require
AIVEN_PG_CA=/absolute/path/to/pg-ca.pem

# Kafka — the activity stream
AIVEN_KAFKA_BROKERS=your-kafka-....aivencloud.com:12345
AIVEN_KAFKA_USERNAME=avnadmin
AIVEN_KAFKA_PASSWORD=...
AIVEN_KAFKA_CA=/absolute/path/to/kafka-ca.pem
# AIVEN_KAFKA_SASL_MECHANISM=scram-sha-256   # the default; only set it if yours differs

# Aiven MCP — the in-world data engineer
AGENTCRAFT_AIVEN_MCP_URL=https://mcp.aiven.live/mcp
AIVEN_TOKEN=...
AIVEN_PROJECT=your-project-name
```

> **Wait, why both the direct Postgres/Kafka clients *and* the MCP?** Different jobs. The MCP is the
> agent-driven path — an agent reasoning about your infra and operating it. The direct `pg`/Kafka clients
> are the boring high-frequency path the sidecar uses to redraw the world many times a second, which is
> way too hot to route through an LLM. Same Aiven, two doors.

## Check it works

With either option set up, run the smokes from `sidecar/`:

```sh
npm run test:aiven-smoke   # migrations + the lock-contention beat + self-heal, on real Postgres
npm run test:kafka-smoke   # an activity pulse: emit -> Kafka -> consumer -> Postgres -> read it back
npm run test:mcp-smoke     # a real MCP call doing a lock claim (run `npm run mcp:local` first, local mode)
```

Each one prints `*_OK` when it's happy, or skips cleanly if its backend isn't configured yet. Then boot
the sidecar and confirm it's live:

```sh
npm start
curl -s 127.0.0.1:8787/health   # -> "aiven":"on"
curl -s 127.0.0.1:8787/ready    # -> "pg":"up"
```

## Keeping secrets safe

- **Never commit credentials.** They live in `sidecar/.env` (gitignored) or your shell, and nowhere else.
- The CA certs are fine to keep around locally. The **Service URI, Kafka password, and API token are
  real secrets** — treat them like passwords.
- SummerCraft redacts secrets from its logs and error responses, but the safest secret is the one that
  never leaves your `.env` in the first place.
- For **public multiplayer**, players must never get raw Aiven credentials. That's the entire job of the
  (roadmap) SummerCraft service — it authenticates people and hands out scoped, short-lived access. Until
  that exists, keep a shared world's keys to yourself.
