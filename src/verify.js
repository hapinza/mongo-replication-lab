// verify.js
// writer 가 "성공"이라고 기록한 id 들이 실제로 DB 에 남아 있는지 확인한다.
// 사라진 게 있으면 그게 롤백된(손실된) 쓰기다.
//
// 반드시 모든 노드가 복귀하고 레플리카셋이 안정된 뒤에 실행해야 한다.
// 구 프라이머리가 복귀하면서 자기 로그를 되감는(rollback) 시점이 있기 때문.

import { MongoClient } from "mongodb";
import fs from "fs";
import path from "path";

const URI = process.env.MONGO_URI;
const LABEL = process.env.LABEL || "run";
const RESULTS_DIR = process.env.RESULTS_DIR || "/app/results";

async function main() {
  const ackedPath = path.join(RESULTS_DIR, `${LABEL}.acked.json`);
  const acked = JSON.parse(fs.readFileSync(ackedPath, "utf8"));

  const client = new MongoClient(URI, {
    readPreference: "primary",
    readConcern: { level: "majority" }, // 과반수에 확정된 것만 읽는다
    serverSelectionTimeoutMS: 10000,
  });
  await client.connect();
  const coll = client.db("lab").collection("writes");

  // 실제로 남아 있는 id 전부 수집
  const present = new Set();
  const cursor = coll.find({}, { projection: { _id: 1 } });
  for await (const doc of cursor) present.add(doc._id);

  const lost = acked.filter((id) => !present.has(id));

  await client.close();

  const result = {
    label: LABEL,
    ackedCount: acked.length,
    presentCount: present.size,
    lostCount: lost.length,
    lostRatio: acked.length ? +(lost.length / acked.length).toFixed(6) : 0,
    lostSample: lost.slice(0, 10),
  };

  fs.writeFileSync(
    path.join(RESULTS_DIR, `${LABEL}.verify.json`),
    JSON.stringify(result, null, 2)
  );

  console.log(
    `[verify] acked=${result.ackedCount} present=${result.presentCount} ` +
    `LOST=${result.lostCount} (${(result.lostRatio * 100).toFixed(4)}%)`
  );
  if (result.lostCount > 0) {
    console.log(`[verify] 예시: ${result.lostSample.slice(0, 3).join(", ")}`);
  }
}

main().catch((e) => {
  console.error("[verify] fatal:", e);
  process.exit(1);
});
