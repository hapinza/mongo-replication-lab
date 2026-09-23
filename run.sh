#!/usr/bin/env bash
# run.sh — 실험 오케스트레이터
#
# 사용법:
#   ./run.sh up                 레플리카셋 기동 + 초기화
#   ./run.sh status             현재 멤버 상태
#   ./run.sh scenario w1-kill   시나리오 하나 실행
#   ./run.sh all                전체 시나리오 실행
#   ./run.sh analyze            결과 표 출력
#   ./run.sh down               정리
#
# 시나리오:
#   w1-kill         w:1 로 쓰는 중에 프라이머리를 kill -9 → 손실 발생하는지
#   majority-kill   w:majority 로 같은 조건 → 손실 없어야 함
#   w1-isolate      w:1, 프라이머리를 네트워크에서 격리 → 롤백 관찰
#   stale-secondary readPreference=secondary → read-your-writes 위반률
#   stale-primary   readPreference=primary  → 대조군 (0% 여야 함)

set -euo pipefail

cd "$(dirname "$0")"

DC="docker compose"
KILL_AT=${KILL_AT:-12}        # 시작 후 몇 초에 프라이머리를 죽일지
RESTORE_AFTER=${RESTORE_AFTER:-12}  # 죽인 뒤 몇 초 후에 복구할지
DURATION_MS=${DURATION_MS:-40000}

log() { printf "\n\033[1;36m=== %s\033[0m\n" "$*"; }

app_run() {
  # app 컨테이너에서 node 스크립트 실행
  $DC run --rm -T app "$@"
}

service_for() {
  # "mongo2:27017" → "mongo2"
  echo "$1" | cut -d: -f1
}

container_for() {
  # "mongo2:27017" → "rs-mongo2"
  echo "rs-$(service_for "$1")"
}

rsnet_name() {
  docker network ls --format '{{.Name}}' | grep -E 'rsnet$' | head -1
}

cmd_up() {
  log "레플리카셋 기동"
  $DC up -d mongo1 mongo2 mongo3
  log "레플리카셋 초기화 (rs-init)"
  $DC up rs-init
  log "app 이미지 빌드"
  $DC build app
  log "준비 대기"
  app_run node src/rs-tools.js wait
}

cmd_status() {
  app_run node src/rs-tools.js status
}

wait_ready() {
  app_run node src/rs-tools.js wait >/dev/null
}

# ---- 페일오버 시나리오 공통 ----
# $1 = label, $2 = writeConcern(1|majority), $3 = mode(kill|isolate)
failover_scenario() {
  local label="$1" wc="$2" mode="$3"

  log "[$label] 시작  writeConcern=$wc  mode=$mode"
  wait_ready

  local before
  before=$(app_run node src/rs-tools.js primary)
  echo "  시작 시점 프라이머리: $before"

  # writer 를 백그라운드로 띄운다
  $DC run --rm -T \
    -e LABEL="$label" \
    -e WC="$wc" \
    -e DURATION_MS="$DURATION_MS" \
    app node src/writer.js &
  local writer_pid=$!

  sleep "$KILL_AT"

  local primary target svc
  primary=$(app_run node src/rs-tools.js primary)
  target=$(container_for "$primary")
  svc=$(service_for "$primary")
  echo ""
  echo "  >>> t=${KILL_AT}s  프라이머리($target) $mode"

  if [ "$mode" = "kill" ]; then
    docker kill "$target" >/dev/null
  else
    docker network disconnect "$(rsnet_name)" "$target" >/dev/null
  fi

  sleep "$RESTORE_AFTER"
  echo "  >>> t=$((KILL_AT + RESTORE_AFTER))s  $target 복구"
  if [ "$mode" = "kill" ]; then
    docker start "$target" >/dev/null
  else
    # --alias 를 줘야 다른 노드들이 예전 호스트명으로 다시 찾을 수 있다
    docker network connect --alias "$svc" "$(rsnet_name)" "$target" >/dev/null
  fi

  # writer 종료 대기
  wait "$writer_pid" || true

  log "[$label] 레플리카셋 안정화 대기 (롤백이 여기서 일어난다)"
  wait_ready
  sleep 5   # 롤백 반영 여유

  log "[$label] 검증"
  $DC run --rm -T -e LABEL="$label" app node src/verify.js
}

# ---- stale read 시나리오 ----
# $1 = label, $2 = readPreference
stale_scenario() {
  local label="$1" pref="$2"
  log "[$label] 시작  readPreference=$pref"
  wait_ready
  $DC run --rm -T \
    -e LABEL="$label" \
    -e READ_PREF="$pref" \
    app node src/stale-read.js
}

cmd_scenario() {
  case "$1" in
    w1-kill)         failover_scenario "w1-kill" "1" "kill" ;;
    majority-kill)   failover_scenario "majority-kill" "majority" "kill" ;;
    w1-isolate)      failover_scenario "w1-isolate" "1" "isolate" ;;
    stale-secondary) stale_scenario "stale-secondary" "secondary" ;;
    stale-primary)   stale_scenario "stale-primary" "primary" ;;
    *) echo "알 수 없는 시나리오: $1"; exit 1 ;;
  esac
}

cmd_all() {
  for s in w1-kill majority-kill w1-isolate stale-secondary stale-primary; do
    cmd_scenario "$s"
    sleep 3
  done
  cmd_analyze
}

cmd_analyze() {
  log "결과"
  app_run node src/analyze.js
}

cmd_down() {
  $DC down -v
}

case "${1:-}" in
  up)       cmd_up ;;
  status)   cmd_status ;;
  scenario) shift; cmd_scenario "$1" ;;
  all)      cmd_all ;;
  analyze)  cmd_analyze ;;
  down)     cmd_down ;;
  *)
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
