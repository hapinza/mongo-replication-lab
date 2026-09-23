// writer.js
// 지정한 writeConcern 으로 계속 쓰기를 날리면서, 서버가 "성공"이라고 응답한
// 문서 id 를 전부 기록한다. 나중에 verify.js 가 그 id 들이 실제로 DB 에
// 남아 있는지 확인한다 → 남아 있지 않으면 그게 "손실된 쓰기"다.
//
// 핵심: 손실의 정의는 "서버가 성공이라고 말했는데 사라진 것"이다.
// 실패 응답을 받은 쓰기가 사라지는 건 손실이 아니다.

import { MongoClient } from "mongodb";
import fs from "fs";
import path from "path";

const URI = process.env.MONGO_URI;
const LABEL = process.env.LABEL || "run";
const W = process.env.WC === "majority" ? "majority" : 1;
const J = process.env.JOURNAL === "true";
const DURATION_MS = parseInt(process.env.DURATION_MS || "40000", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "10", 10);
const OP_DELAY_MS = parseInt(process.env.OP_DELAY_MS || "5", 10);
// retryWrites 를 켜면 드라이버가 페일오버 시 새 프라이머리에 한 번 자동 재시도한다.
// 현상을 그대로 보려면 꺼두는 게 좋다. 켜고 끈 차이를 비교해보는 것도 실험거리.
const RETRY_WRITES = process.env.RETRY_WRITES === "true";

const RESULTS_DIR = process.env.RESULTS_DIR || "/app/results";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const client = new MongoClient(URI, {
    writeConcern: { w: W, j: J },
    retryWrites: RETRY_WRITES,
    serverSelectionTimeoutMS: 3000,
    // 페일오버를 빨리 감지하도록
    heartbeatFrequencyMS: 500,
  });

  await client.connect();
  const coll = client.db("lab").collection("writes");

  // 매 실행마다 깨끗한 상태에서 시작
  await coll.deleteMany({});
  console.log(`[writer] collection cleared. label=${LABEL} w=${W} j=${J} retryWrites=${RETRY_WRITES}`);

  const acked = [];        // 서버가 성공이라고 응답한 _id 들
  const latencies = [];    // 성공한 쓰기의 레이턴시 (ms)
  const errors = [];       // { t, name, message }
  let seq = 0;
  let failed = 0;

  const startedAt = Date.now();
  const deadline = startedAt + DURATION_MS;

  async function worker(workerId) {
    while (Date.now() < deadline) {
      const id = `${LABEL}-${seq++}`;
      const t0 = Date.now();
      try {
        await coll.insertOne({
          _id: id,
          w: workerId,
          ts: new Date(),
          // 문서에 약간의 무게를 줘서 복제가 즉시 끝나지 않게 한다
          payload: "x".repeat(256),
        });
        const dt = Date.now() - t0;
        acked.push(id);
        latencies.push(dt);
      } catch (e) {
        failed++;
        errors.push({
          t: Date.now() - startedAt,
          name: e.name,
          message: String(e.message).slice(0, 160),
        });
        // 페일오버 중에는 계속 실패한다. 바쁜 루프를 막는다.
        await sleep(50);
      }
      if (OP_DELAY_MS > 0) await sleep(OP_DELAY_MS);
    }
  }

  // 진행 상황 표시
  const ticker = setInterval(() => {
    const el = ((Date.now() - startedAt) / 1000).toFixed(0);
    process.stdout.write(`\r[writer] ${el}s  acked=${acked.length}  failed=${failed}   `);
  }, 1000);

  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => worker(i))
  );

  clearInterval(ticker);
  process.stdout.write("\n");

  await client.close();

  // 실패가 연속된 구간 = 쓰기 불가 시간 (페일오버 윈도우)
  let unavailableMs = 0;
  if (errors.length > 0) {
    unavailableMs = errors[errors.length - 1].t - errors[0].t;
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const summary = {
    label: LABEL,
    writeConcern: { w: W, j: J },
    retryWrites: RETRY_WRITES,
    durationMs: Date.now() - startedAt,
    concurrency: CONCURRENCY,
    ackedCount: acked.length,
    failedCount: failed,
    throughputPerSec: +(acked.length / ((Date.now() - startedAt) / 1000)).toFixed(1),
    latencyMs: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.length ? sorted[sorted.length - 1] : null,
    },
    // 첫 실패 ~ 마지막 실패 사이 = 대략적인 쓰기 불가 구간
    firstErrorAtMs: errors.length ? errors[0].t : null,
    lastErrorAtMs: errors.length ? errors[errors.length - 1].t : null,
    approxUnavailableMs: unavailableMs,
    errorSample: errors.slice(0, 5),
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(RESULTS_DIR, `${LABEL}.acked.json`),
    JSON.stringify(acked)
  );
  fs.writeFileSync(
    path.join(RESULTS_DIR, `${LABEL}.writer.json`),
    JSON.stringify(summary, null, 2)
  );

  console.log(`[writer] done. acked=${acked.length} failed=${failed} ` +
    `p95=${summary.latencyMs.p95}ms unavailable~${unavailableMs}ms`);
}

main().catch((e) => {
  console.error("[writer] fatal:", e);
  process.exit(1);
});
