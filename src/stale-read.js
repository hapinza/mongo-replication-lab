// stale-read.js
// read-your-writes 위반을 측정한다.
// 프라이머리에 쓰고 → 곧바로 지정한 readPreference 로 같은 문서를 읽는다.
// 안 보이면 stale read. 보일 때까지 폴링해서 복제 지연(ms)도 잰다.
//
// 장애가 없어도 매일 일어나는 현상이라, 여기서는 노드를 죽이지 않는다.
// 대신 백그라운드 부하를 깔아서 복제 지연을 눈에 보이게 만든다.
//
// 디스크 안전장치:
//   - bgload 를 capped collection 으로 만든다 → 정해진 크기를 넘으면
//     오래된 문서를 자동으로 덮어쓴다. 무한정 쌓이지 않는다.
//   - 총 백그라운드 쓰기량에 상한(BG_MAX_WRITES)을 둔다.

import { MongoClient } from "mongodb";
import fs from "fs";
import path from "path";

const URI = process.env.MONGO_URI;
const LABEL = process.env.LABEL || "stale";
const READ_PREF = process.env.READ_PREF || "secondary"; // primary | secondary | secondaryPreferred
const PROBES = parseInt(process.env.PROBES || "100", 10);
const BG_CONCURRENCY = parseInt(process.env.BG_CONCURRENCY || "6", 10);
const BG_DOC_BYTES = parseInt(process.env.BG_DOC_BYTES || "2048", 10);
const BG_BATCH = parseInt(process.env.BG_BATCH || "10", 10);
// capped collection 크기 (바이트). 이 크기를 넘으면 오래된 것부터 덮어쓴다.
const BG_CAP_BYTES = parseInt(process.env.BG_CAP_BYTES || String(128 * 1024 * 1024), 10);
// 백그라운드 총 쓰기 건수 상한. 넘으면 부하를 멈춘다.
const BG_MAX_WRITES = parseInt(process.env.BG_MAX_WRITES || "200000", 10);
const MAX_WAIT_MS = parseInt(process.env.MAX_WAIT_MS || "3000", 10);
const RESULTS_DIR = process.env.RESULTS_DIR || "/app/results";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  // 쓰기용 클라이언트: 프라이머리, w:1 (빨리 ack 받고 바로 읽어보려고)
  const wClient = new MongoClient(URI, {
    writeConcern: { w: 1 },
    readPreference: "primary",
    serverSelectionTimeoutMS: 5000,
  });
  // 읽기용 클라이언트: 지정한 readPreference, readConcern local
  const rClient = new MongoClient(URI, {
    readPreference: READ_PREF,
    readConcern: { level: "local" },
    serverSelectionTimeoutMS: 5000,
  });

  await Promise.all([wClient.connect(), rClient.connect()]);

  const db = wClient.db("lab");
  const wColl = db.collection("probe");
  const rColl = rClient.db("lab").collection("probe");

  await wColl.deleteMany({});

  // bgload 를 capped collection 으로 다시 만든다.
  // capped 는 크기가 고정이라 디스크를 무한정 먹지 않는다.
  try {
    await db.collection("bgload").drop();
  } catch (e) {
    // 없으면 무시
  }
  await db.createCollection("bgload", { capped: true, size: BG_CAP_BYTES });
  const bgColl = db.collection("bgload");

  console.log(
    `[stale] readPref=${READ_PREF} probes=${PROBES} bgWorkers=${BG_CONCURRENCY} ` +
    `cap=${(BG_CAP_BYTES / 1024 / 1024).toFixed(0)}MB maxBgWrites=${BG_MAX_WRITES}`
  );

  // ---- 백그라운드 부하 (복제 지연을 만들어내기 위한 것) ----
  let bgRunning = true;
  let bgCount = 0;
  const payload = "y".repeat(BG_DOC_BYTES);

  async function bgWorker() {
    while (bgRunning && bgCount < BG_MAX_WRITES) {
      try {
        await bgColl.insertMany(
          Array.from({ length: BG_BATCH }, () => ({ payload, ts: new Date() })),
          { ordered: false }
        );
        bgCount += BG_BATCH;
      } catch (e) {
        await sleep(20);
      }
    }
  }
  const bgTasks = Array.from({ length: BG_CONCURRENCY }, () => bgWorker());

  // 부하가 걸리기 시작할 시간을 준다
  await sleep(1500);

  // ---- 프로브 ----
  let staleCount = 0;
  let timeoutCount = 0;
  const lags = [];

  const startedAt = Date.now();

  for (let i = 0; i < PROBES; i++) {
    const id = `probe-${Date.now()}-${i}`;
    await wColl.insertOne({ _id: id, ts: new Date() });

    // 쓰기 직후 즉시 읽기
    const t0 = Date.now();
    let found = await rColl.findOne({ _id: id });

    if (!found) {
      staleCount++;
      // 보일 때까지 폴링 → 복제 지연 측정
      let waited = 0;
      while (!found && waited < MAX_WAIT_MS) {
        await sleep(2);
        waited = Date.now() - t0;
        found = await rColl.findOne({ _id: id });
      }
      if (found) {
        lags.push(waited);
      } else {
        timeoutCount++;
      }
    }

    // 진행 표시는 매번 줄바꿈해서 출력한다 (\r 은 파이프라인에서 안 보인다)
    if ((i + 1) % 10 === 0) {
      const el = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(
        `[stale] ${i + 1}/${PROBES}  stale=${staleCount}  bgWrites=${bgCount}  ${el}s`
      );
    }
    await sleep(10);
  }

  bgRunning = false;
  await Promise.all(bgTasks);

  // 실험 끝나면 백그라운드 데이터 정리 (디스크 회수)
  try {
    await bgColl.drop();
  } catch (e) {}

  await Promise.all([wClient.close(), rClient.close()]);

  const sortedLags = [...lags].sort((a, b) => a - b);
  const result = {
    label: LABEL,
    readPreference: READ_PREF,
    probes: PROBES,
    backgroundWrites: bgCount,
    staleCount,
    staleRatio: +(staleCount / PROBES).toFixed(4),
    timeoutCount,
    replicationLagMs: {
      p50: percentile(sortedLags, 50),
      p95: percentile(sortedLags, 95),
      p99: percentile(sortedLags, 99),
      max: sortedLags.length ? sortedLags[sortedLags.length - 1] : null,
      samples: sortedLags.length,
    },
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(RESULTS_DIR, `${LABEL}.stale.json`),
    JSON.stringify(result, null, 2)
  );

  console.log(
    `[stale] done. readPref=${READ_PREF} stale=${staleCount}/${PROBES} ` +
    `(${(result.staleRatio * 100).toFixed(1)}%) lag p95=${result.replicationLagMs.p95}ms`
  );
}

main().catch((e) => {
  console.error("[stale] fatal:", e);
  process.exit(1);
});
