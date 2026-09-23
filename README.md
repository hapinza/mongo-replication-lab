# MongoDB Replica Set Failure Lab

A reproducible lab that injects failures into a 3-node MongoDB replica set and
measures what each durability setting actually costs.

Two questions, measured rather than assumed:

1. **Write loss** — when the server says "OK", does the write survive a primary failure?
2. **Stale reads** — how often does reading from a secondary fail to show a write you just made?

Everything runs in Docker. `./run.sh up` (or `.\run.ps1 up` on Windows), then one
command per scenario.

---

## Results

### 1. Write loss during primary failure

Same 3-node cluster. Two variables changed: `writeConcern`, and how the primary fails.

| Scenario | writeConcern | Failure | Acked writes | **Lost** | p50 | p95 | p99 | Throughput |
|---|---|---|---|---|---|---|---|---|
| `w1-kill` | `w:1` | SIGKILL | 15,666 | **11** (0.070%) | 9ms | 36ms | 77ms | 390/s |
| `majority-kill` | `w:majority` | SIGKILL | 4,465 | **0** (0.000%) | 51ms | 125ms | 301ms | 112/s |
| `w1-isolate` | `w:1` | Network partition | 3,120 | **2** (0.064%) | 35ms | 125ms | 206ms | 78/s |

*Lost* = the server returned success, but the write is not in the database after the
cluster stabilizes. Writes that returned an error are **not** counted as lost — the
client knew about those and could retry.

### 2. Read-your-writes violations

No failure injected. Just background write load.

| readPreference | Probes | Stale | Rate | Replication lag p50 | p95 | max |
|---|---|---|---|---|---|---|
| `primary` | 100 | 0 | **0.0%** | — | — | — |
| `secondary` | 100 | 88 | **88.0%** | 36ms | 134ms | 183ms |

Each probe writes a document, then immediately reads it back. The 88% figure is the
worst case — reading with zero delay after the ack.

---

## What the numbers mean

### `w:majority` eliminates loss structurally, not probabilistically

With `w:majority`, a write is acknowledged only after a majority of nodes have it.
Any new primary needs a majority of votes to be elected, and any two majorities
overlap in at least one node — so the winning candidate necessarily holds every
acknowledged write. Rollback of an acked write is not unlikely; it is impossible.

The 11 writes lost under `w:1` confirm this from the other direction. Their IDs were
**consecutive** (`w1-kill-4638`, `4639`, `4641`) and clustered at the instant of the
kill — exactly the replication-lag window where the primary had committed locally but
had not yet replicated.

### The cost lands on p50, not on the tail

| | p50 | p95 | p99 | Throughput |
|---|---|---|---|---|
| ratio (`majority` ÷ `w:1`) | **5.7x** | 3.5x | 3.9x | 1/3.5 |

The median moved most. Waiting for a majority is not a rare tail event — it adds a
network round trip to *every* write, shifting the whole distribution. The honest
summary of the cost is not "worse tail latency" but **one third of the throughput on
the same hardware**.

### The failure *type* changed latency as much as the config did

`w1-kill` and `w1-isolate` use identical settings. Their p50 differs 4x (9ms vs 35ms)
and throughput 5x.

A SIGKILL drops TCP connections immediately, so the driver detects the failure and
fails over fast. A network partition sends packets into a void — no RST, no response.
Client writes **hung** rather than failing.

This shows up as a striking gap in the logs:

```
t=14s  acked=1687  failed=0
t=12s  <primary isolated>
t=27s  acked=1888  failed=0   ← 13 seconds, 201 writes, zero errors
t=28s  acked=1888  failed=0   ← fully stalled
```

Zero errors for 13 seconds while throughput was effectively zero. **An error-rate
dashboard would have shown all green through this outage.** Detecting hang-type
failures requires watching throughput and latency, not just errors.

This is the practical face of a theoretical result: a node that is slow and a node
that is dead are indistinguishable from the outside.

### The isolated primary kept acking doomed writes

Only 2 writes were lost in `w1-isolate`, and they were the last two the isolated
primary accepted:

```
t≈14s  primary partitioned away from the majority
       ...but it still believes it is primary
       w:1 → it commits locally and returns success
       → these writes can never replicate
t≈17s  primary notices it cannot reach a majority → steps down
t=24s  rejoins → rolls back to match the new primary → the writes vanish
```

The size of that window is `electionTimeoutMillis`. This lab sets it to 3s; the
default is 10s. **With defaults, a partitioned primary can return false success for
up to ten seconds.** Under `w:majority` these acks never happen in the first place —
the majority response never arrives, so the write fails cleanly.

### Failed ≠ not applied

In the `majority-kill` run, the database ended up with *more* documents than the
client counted as successful:

```
acked = 4,465    present = 4,482    lost = 0
```

17 writes were applied on the server but reported as failures to the client — the
write committed, the response never made it back. From the client's side these are
**unknown outcome**: not success, not failure.

A client that retries on failure will duplicate them. This is the concrete reason
write paths need idempotency, and why MongoDB's `retryWrites` attaches a transaction
ID so the server can recognize a retry of a write it already applied.

### Stale reads: carry the lag, not the percentage

88% is an artifact of reading with zero delay. The number to design against is the
lag distribution: **p50 36ms, p95 134ms, max 183ms** — a tight spread.

| When the read happens | Outcome |
|---|---|
| Same request handler, right after the write | Almost always stale |
| After a round trip to the user (~100–300ms) | Sometimes stale |
| Seconds later | Essentially never stale |

So the design rule is not "never read from secondaries" but "read-after-write paths
cannot tolerate secondary reads," with three standard fixes: route those paths to the
primary, use causally consistent sessions (the client carries its last write's
timestamp and the secondary waits to catch up), or hide the gap client-side with an
optimistic update.

---

## Method

**Loss detection.** The writer records the `_id` of every write the server
acknowledged. After the cluster stabilizes, a verifier reads the collection with
`readConcern: majority` and diffs the two sets. Anything acknowledged but absent is a
lost write.

**Why `retryWrites` is off.** The driver's automatic retry would mask failover by
transparently resending to the new primary. It is disabled by default here so the
raw behavior is visible; `RETRY_WRITES=true` runs the comparison.

**Election tuning.** `electionTimeoutMillis` is 3s (default 10s) and
`heartbeatIntervalMillis` is 500ms, to keep each run short. Real-world failover
windows are longer.

**Stale-read load.** Background writers create replication lag; the probe collection
is separate. The background collection is capped so the lab cannot fill the disk.

---

## Reproducing

```bash
./run.sh up                        # start 3 nodes, initialize the replica set
./run.sh scenario w1-kill
./run.sh scenario majority-kill
./run.sh scenario w1-isolate
./run.sh scenario stale-secondary
./run.sh scenario stale-primary
./run.sh analyze                   # prints the tables, writes results/REPORT.md
./run.sh down
```

Windows PowerShell: `.\run.ps1` with the same arguments.

Tunable: `-KillAt`, `-RestoreAfter`, `-DurationMs`, and per-script environment
variables (`WC`, `JOURNAL`, `RETRY_WRITES`, `CONCURRENCY`, `READ_PREF`, `PROBES`).

---

## Limitations

- **Single host.** All three nodes run as containers on one machine, so network
  latency between them is unrealistically low. Real cross-AZ deployments pay more for
  `w:majority` than this lab shows.
- **The "write unavailable" column merges two events.** In `majority-kill` the
  restarted node had `priority: 2`, so rejoining triggered a *second* election. The
  25.1s figure spans both failovers and should not be read as majority-writes causing
  4x the downtime — election duration is independent of `writeConcern`.
- **Small sample.** One run per scenario. Loss counts in the single digits are not
  precise rates; they establish that loss occurs, not how often.
- **Latency percentiles include failover.** They are not steady-state benchmarks.

---

## What I would measure next

- `w:3` — every node must ack. One slow node stalls all writes, which is why majority
  rather than "all" is the standard quorum.
- `readConcern` levels: `local` vs `majority` vs `linearizable`, and what each costs.
- Equal `priority` on all members, to confirm the second election disappears.
- Killing two of three nodes — the majority is gone, no primary can be elected, and
  writes stop indefinitely. The concrete shape of choosing consistency over
  availability.
