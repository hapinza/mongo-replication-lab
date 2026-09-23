// analyze.js
// results/ 안의 JSON 들을 모아서 표로 출력하고 results/REPORT.md 를 쓴다.

import fs from "fs";
import path from "path";

const RESULTS_DIR = process.env.RESULTS_DIR || "/app/results";

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), "utf8"));
  } catch (e) {
    return null;
  }
}

function pad(s, n) {
  s = String(s ?? "-");
  return s + " ".repeat(Math.max(0, n - s.length));
}

const failoverLabels = ["w1-kill", "majority-kill", "w1-isolate"];
const staleLabels = ["stale-primary", "stale-secondary"];

const rows = [];
for (const label of failoverLabels) {
  const w = readJson(`${label}.writer.json`);
  const v = readJson(`${label}.verify.json`);
  if (!w || !v) continue;
  rows.push({
    label,
    wc: `w:${w.writeConcern.w}`,
    acked: w.ackedCount,
    lost: v.lostCount,
    lostPct: (v.lostRatio * 100).toFixed(4) + "%",
    failed: w.failedCount,
    unavailable: w.approxUnavailableMs != null ? `${(w.approxUnavailableMs / 1000).toFixed(1)}s` : "-",
    p50: w.latencyMs.p50,
    p95: w.latencyMs.p95,
    p99: w.latencyMs.p99,
    tput: w.throughputPerSec,
  });
}

const staleRows = [];
for (const label of staleLabels) {
  const s = readJson(`${label}.stale.json`);
  if (!s) continue;
  staleRows.push({
    label,
    pref: s.readPreference,
    probes: s.probes,
    stale: s.staleCount,
    stalePct: (s.staleRatio * 100).toFixed(1) + "%",
    lagP50: s.replicationLagMs.p50,
    lagP95: s.replicationLagMs.p95,
    lagMax: s.replicationLagMs.max,
  });
}

let out = "";

out += "\n장애 실험 (프라이머리 다운 중 쓰기)\n";
out += "─".repeat(104) + "\n";
out += pad("시나리오", 16) + pad("writeConcern", 14) + pad("ack된 쓰기", 12) +
       pad("손실", 8) + pad("손실률", 11) + pad("쓰기불가", 10) +
       pad("p50", 7) + pad("p95", 7) + pad("p99", 7) + pad("tput/s", 8) + "\n";
out += "─".repeat(104) + "\n";
for (const r of rows) {
  out += pad(r.label, 16) + pad(r.wc, 14) + pad(r.acked, 12) +
         pad(r.lost, 8) + pad(r.lostPct, 11) + pad(r.unavailable, 10) +
         pad(r.p50, 7) + pad(r.p95, 7) + pad(r.p99, 7) + pad(r.tput, 8) + "\n";
}
if (rows.length === 0) out += "(아직 결과 없음)\n";

out += "\n\nstale read 실험 (장애 없음, 백그라운드 부하 상태)\n";
out += "─".repeat(90) + "\n";
out += pad("시나리오", 18) + pad("readPreference", 18) + pad("프로브", 9) +
       pad("stale", 8) + pad("비율", 9) + pad("지연p50", 10) + pad("지연p95", 10) + pad("지연max", 9) + "\n";
out += "─".repeat(90) + "\n";
for (const r of staleRows) {
  out += pad(r.label, 18) + pad(r.pref, 18) + pad(r.probes, 9) +
         pad(r.stale, 8) + pad(r.stalePct, 9) +
         pad(r.lagP50, 10) + pad(r.lagP95, 10) + pad(r.lagMax, 9) + "\n";
}
if (staleRows.length === 0) out += "(아직 결과 없음)\n";

out += "\n";
console.log(out);

// ---- 마크다운 리포트 ----
let md = `# MongoDB 복제 실험 결과\n\n`;
md += `생성: ${new Date().toISOString()}\n\n`;

md += `## 1. 프라이머리 장애 중 쓰기 손실\n\n`;
md += `| 시나리오 | writeConcern | ack된 쓰기 | 손실 | 손실률 | 쓰기 불가 | p50 | p95 | p99 | 처리량/s |\n`;
md += `|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
  md += `| ${r.label} | ${r.wc} | ${r.acked} | **${r.lost}** | ${r.lostPct} | ${r.unavailable} | ${r.p50}ms | ${r.p95}ms | ${r.p99}ms | ${r.tput} |\n`;
}

md += `\n손실 = 서버가 성공이라고 응답했는데 최종적으로 DB에 남지 않은 쓰기.\n`;
md += `실패 응답을 받은 쓰기는 손실로 세지 않는다.\n`;

md += `\n## 2. read-your-writes 위반 (stale read)\n\n`;
md += `| 시나리오 | readPreference | 프로브 | stale | 비율 | 복제지연 p50 | p95 | max |\n`;
md += `|---|---|---|---|---|---|---|---|\n`;
for (const r of staleRows) {
  md += `| ${r.label} | ${r.pref} | ${r.probes} | ${r.stale} | ${r.stalePct} | ${r.lagP50}ms | ${r.lagP95}ms | ${r.lagMax}ms |\n`;
}
md += `\n장애 없이, 백그라운드 쓰기 부하만 걸린 평상시 상태에서 측정.\n`;

md += `\n## 3. 읽을 때 보는 것\n\n`;
md += `- \`w:1\` 과 \`w:majority\` 의 **손실** 칸 차이 — 이게 비동기 복제의 대가다.\n`;
md += `- 같은 두 줄의 **p95/p99** 차이 — 그 안전성을 얼마에 샀는지.\n`;
md += `- \`w1-isolate\` 의 손실 — kill 과 달리 구 프라이머리가 살아서 쓰기를 받다가 롤백된 경우.\n`;
md += `- **쓰기 불가** 시간 — 선거가 끝날 때까지 쓰기가 멈춘 구간. 가용성을 포기하고 일관성을 지킨 시간.\n`;
md += `- stale 표의 \`primary\` vs \`secondary\` — 읽기를 분산한 대가.\n`;

fs.writeFileSync(path.join(RESULTS_DIR, "REPORT.md"), md);
console.log("→ results/REPORT.md 저장됨\n");
