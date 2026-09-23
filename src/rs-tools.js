// rs-tools.js
// 레플리카셋 상태를 조회하는 작은 유틸. run.sh 에서 호출한다.
//   node src/rs-tools.js primary   → 현재 프라이머리 호스트명 출력 (예: mongo1:27017)
//   node src/rs-tools.js wait      → 프라이머리가 뽑히고 모든 멤버가 healthy 할 때까지 대기
//   node src/rs-tools.js status    → 멤버 상태 요약

import { MongoClient } from "mongodb";

const URI = process.env.MONGO_URI;
const cmd = process.argv[2] || "status";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withAdmin(fn) {
  const client = new MongoClient(URI, {
    serverSelectionTimeoutMS: 3000,
    directConnection: false,
    readPreference: "primaryPreferred",
  });
  await client.connect();
  try {
    return await fn(client.db("admin"));
  } finally {
    await client.close();
  }
}

async function getStatus() {
  return withAdmin((admin) => admin.command({ replSetGetStatus: 1 }));
}

async function main() {
  if (cmd === "primary") {
    const st = await getStatus();
    const p = st.members.find((m) => m.stateStr === "PRIMARY");
    if (!p) {
      console.error("no primary");
      process.exit(2);
    }
    console.log(p.name);
    return;
  }

  if (cmd === "wait") {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try {
        const st = await getStatus();
        const primary = st.members.find((m) => m.stateStr === "PRIMARY");
        const healthy = st.members.filter(
          (m) => m.stateStr === "PRIMARY" || m.stateStr === "SECONDARY"
        );
        if (primary && healthy.length === st.members.length) {
          console.log(`ready: primary=${primary.name} members=${healthy.length}`);
          return;
        }
        // 진행 표시는 stderr 로. stdout 은 파싱 대상이라 깨끗하게 유지한다.
        process.stderr.write(
          `\r[wait] primary=${primary ? primary.name : "none"} healthy=${healthy.length}/${st.members.length}   `
        );
      } catch (e) {
        process.stderr.write(`\r[wait] ${String(e.message).slice(0, 60)}   `);
      }
      await sleep(1000);
    }
    process.stderr.write("\n");
    console.error("timeout waiting for replica set");
    process.exit(3);
  }

  // status
  const st = await getStatus();
  for (const m of st.members) {
    console.log(`${m.name.padEnd(18)} ${m.stateStr.padEnd(10)} health=${m.health}`);
  }
}

main().catch((e) => {
  console.error(String(e.message));
  process.exit(1);
});
