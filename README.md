# MongoDB 복제 실험 랩

MongoDB 레플리카셋 3노드를 띄우고, 부하를 주는 도중에 프라이머리를 죽여서
**설정에 따라 데이터가 어떻게 달라지는지 직접 측정**하는 실험 환경.

측정하는 것 두 가지:

1. **쓰기 손실** — 서버가 "성공"이라고 응답했는데 최종적으로 사라진 쓰기가 몇 건인가
2. **stale read** — 방금 쓴 걸 바로 못 읽는 경우가 몇 %인가 (장애 없이도 일어남)

---

## 0. 필요한 것

Docker Desktop 만 있으면 된다. Node 는 컨테이너 안에서 돈다.

```
docker --version
docker compose version
```

**Windows (PowerShell)** 는 `run.ps1`, **macOS / Linux / WSL / Git Bash** 는 `run.sh` 를 쓴다.
아래 예시는 PowerShell 기준이고, bash 는 `.\run.ps1` 을 `./run.sh` 로 바꾸면 그대로 같다.

PowerShell 에서 스크립트 실행이 막혀 있으면 한 번만:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

---

## 1. 기동

```powershell
.\run.ps1 up
```

bash:

```bash
chmod +x run.sh
./run.sh up
```

하는 일:
- mongo 3개 컨테이너 기동 (rs-mongo1/2/3)
- 레플리카셋 `rs0` 초기화
- 실험용 Node 이미지 빌드
- 프라이머리가 뽑힐 때까지 대기

상태 확인:

```powershell
.\run.ps1 status
# mongo1:27017      PRIMARY    health=1
# mongo2:27017      SECONDARY  health=1
# mongo3:27017      SECONDARY  health=1
```

---

## 2. 시나리오 하나씩 돌리기

```powershell
.\run.ps1 scenario w1-kill
```

| 시나리오 | 하는 일 | 봐야 할 것 |
|---|---|---|
| `w1-kill` | `w:1` 로 쓰는 중 프라이머리 `kill -9` | **손실이 나온다** |
| `majority-kill` | `w:majority` 로 같은 조건 | **손실 0이어야 한다** |
| `w1-isolate` | `w:1`, 프라이머리를 네트워크에서 격리 | 롤백된 쓰기 |
| `stale-secondary` | `readPreference=secondary` 로 읽기 | 위반률 높게 나옴 |
| `stale-primary` | `readPreference=primary` (대조군) | 0%여야 함 |

전부 한 번에:

```powershell
.\run.ps1 all
```

결과 표:

```powershell
.\run.ps1 analyze
```

`results/REPORT.md` 에 마크다운으로도 저장된다.

---

## 3. 한 시나리오가 실제로 하는 일

`w1-kill` 기준 타임라인:

```
t=0s    writer 시작. 10개 워커가 계속 insert.
        성공 응답을 받은 _id 를 전부 기록.
t=12s   현재 프라이머리 컨테이너를 kill -9
        → 하트비트 끊김 → 남은 2대가 선거
        → 이 구간 동안 쓰기 전부 실패 (쓰기 불가 시간)
t=15s쯤  새 프라이머리 선출. 쓰기 재개.
t=24s   죽인 노드 재기동
        → 복귀하면서 자기 로그를 새 프라이머리에 맞춰 되감음 (rollback)
t=40s   writer 종료
        레플리카셋 안정화 대기
        verify: 기록해둔 "성공한 _id" 가 실제로 DB에 남아 있는지 대조
        → 사라진 게 손실
```

**손실의 정의가 핵심이다.** 실패 응답을 받은 쓰기가 사라지는 건 손실이 아니다.
서버가 성공이라고 말했는데 사라진 것만 손실로 센다.

---

## 4. 결과 읽는 법

```
시나리오          writeConcern  ack된 쓰기   손실   손실률    쓰기불가  p50  p95  p99
w1-kill          w:1           12480       37    0.2965%  4.2s     2    6    14
majority-kill    w:majority    11020       0     0.0000%  4.6s     4    11   26
```

이 두 줄이 비동기 복제의 트레이드오프 전부다.

- **손실 칸**: `w:1` 은 프라이머리 커밋만으로 성공을 반환한다. 복제되기 전에
  프라이머리가 죽으면 그 쓰기는 없던 게 된다. `w:majority` 는 과반수가 받아야
  성공이라 이런 손실이 구조적으로 불가능하다.
- **p95/p99 칸**: 그 안전성을 얼마에 샀는지. 네트워크 왕복이 한 번 더 들어간다.
- **쓰기불가 칸**: 선거가 끝날 때까지 쓰기가 아예 안 되는 구간.
  가용성을 포기하고 일관성을 지킨 시간이다.
  (이 랩은 `electionTimeoutMillis` 를 3초로 줄여놨다. 기본값은 10초라 실제로는 더 길다.)

stale read 표:

```
시나리오           readPreference  프로브  stale  비율    지연p50  지연p95
stale-primary     primary         300    0      0.0%    -       -
stale-secondary   secondary       300    214    71.3%   18      96
```

이쪽은 **장애가 없는 평상시**에 측정한 거다. 읽기를 복제본으로 분산하는 순간
read-your-writes 가 깨진다. 사용자가 저장 버튼 누르고 새로고침했는데 예전 값이
보이는 현상이 이거다.

---

## 5. 직접 바꿔볼 것들

**타이밍** — PowerShell 은 파라미터로, bash 는 환경변수로 준다.

```powershell
# 더 일찍 죽이기 / 더 오래 죽여두기 / 더 길게 돌리기
.\run.ps1 scenario w1-kill -KillAt 5 -RestoreAfter 20 -DurationMs 90000
```

```bash
KILL_AT=5 RESTORE_AFTER=20 DURATION_MS=90000 ./run.sh scenario w1-kill
```

**writer / stale 동작** — 아래 변수들은 `docker compose run` 의 `-e` 로 직접 준다.

```powershell
# 예: 드라이버 자동 재시도를 켜고 돌려보기
docker compose run --rm -T -e LABEL=w1-retry -e WC=1 -e RETRY_WRITES=true `
  app node src/writer.js
```

writer 쪽 변수 (`src/writer.js`):

| 변수 | 기본값 | 의미 |
|---|---|---|
| `WC` | `1` | `1` 또는 `majority` |
| `JOURNAL` | `false` | `true` 면 디스크 저널까지 기다림 (`j:true`) |
| `RETRY_WRITES` | `false` | 드라이버 자동 재시도. **켜고 끈 차이를 비교해보면 재밌다** |
| `CONCURRENCY` | `10` | 동시 쓰기 워커 수 |
| `OP_DELAY_MS` | `5` | 워커당 쓰기 간격 |

`RETRY_WRITES=true` 로 해보면 손실이 줄어든다. 드라이버가 페일오버를 감지하고
새 프라이머리에 한 번 다시 보내기 때문이다. 이게 왜 안전한지
(멱등성을 어떻게 보장하는지) 찾아보면 그 자체가 좋은 공부거리다.

stale 쪽 변수 (`src/stale-read.js`):

| 변수 | 기본값 | 의미 |
|---|---|---|
| `READ_PREF` | `secondary` | `primary` / `secondary` / `secondaryPreferred` |
| `PROBES` | `300` | 프로브 횟수 |
| `BG_CONCURRENCY` | `20` | 백그라운드 부하 워커 수 — 늘리면 복제 지연이 커진다 |
| `BG_DOC_BYTES` | `4096` | 백그라운드 문서 크기 |

---

## 6. 더 해볼 만한 것

- **`w:3` 으로 해보기** — 모든 노드가 받아야 성공. 노드 하나만 느려도 전체 쓰기가
  멈춘다. 왜 과반수(`majority`)가 절충안인지 몸으로 알게 된다.
- **`readConcern` 바꿔보기** — `local` vs `majority` vs `linearizable`.
  각각 뭘 보장하고 얼마나 느린지.
- **격리 시간 늘리기** — `-RestoreAfter 60` 으로 하면 구 프라이머리가 한참 뒤에
  복귀한다. 롤백 파일이 생기는 걸 볼 수 있다
  (`docker exec rs-mongo1 ls /data/db/rollback`).
- **노드 2개 죽이기** — 과반수가 깨진다. 남은 1대는 프라이머리가 될 수 없어서
  쓰기가 영원히 안 된다. 이게 "가용성을 포기한다"의 실제 모습이다.

---

## 7. 정리

```powershell
.\run.ps1 down
```

---

## 파일 구조

```
docker-compose.yml     mongo 3노드 + 실험용 app 컨테이너
Dockerfile             app 이미지 (node + mongodb 드라이버)
run.ps1                오케스트레이터 (Windows PowerShell)
run.sh                 오케스트레이터 (macOS / Linux / WSL / Git Bash)
scripts/rs-init.js     레플리카셋 초기화
src/writer.js          부하 생성 + ack된 쓰기 기록
src/verify.js          ack된 쓰기가 살아남았는지 대조
src/stale-read.js      read-your-writes 위반 측정
src/rs-tools.js        프라이머리 조회 / 안정화 대기
src/analyze.js         결과 표 + REPORT.md 생성
results/               실험 결과 (JSON + REPORT.md)
```
