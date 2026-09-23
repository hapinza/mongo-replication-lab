// 레플리카셋 초기화. 컨테이너가 전부 healthy 해진 뒤 한 번만 실행된다.
// 이미 초기화돼 있으면 조용히 넘어간다.

const config = {
  _id: "rs0",
  members: [
    { _id: 0, host: "mongo1:27017", priority: 2 }, // 초기 프라이머리로 유도
    { _id: 1, host: "mongo2:27017", priority: 1 },
    { _id: 2, host: "mongo3:27017", priority: 1 },
  ],
  settings: {
    // 선거를 빨리 끝내서 실험 시간을 줄인다 (기본 10초 → 3초)
    electionTimeoutMillis: 3000,
    heartbeatIntervalMillis: 500,
  },
};

try {
  const status = rs.status();
  print(`[rs-init] already initialized: ${status.set}`);
} catch (e) {
  // NotYetInitialized
  print("[rs-init] initiating replica set...");
  const r = rs.initiate(config);
  printjson(r);
}

// 프라이머리가 뽑힐 때까지 대기
let primary = null;
for (let i = 0; i < 60; i++) {
  try {
    const hello = db.hello();
    if (hello.primary) {
      primary = hello.primary;
      break;
    }
  } catch (e) {}
  sleep(1000);
}

if (primary) {
  print(`[rs-init] primary elected: ${primary}`);
} else {
  print("[rs-init] WARNING: no primary after 60s");
  quit(1);
}

// 실험용 DB/컬렉션 미리 생성 (첫 쓰기의 암묵적 생성 지연을 제거)
const target = db.getSiblingDB("lab");
try {
  target.createCollection("writes");
} catch (e) {}
print("[rs-init] done");
