<#
run.ps1 - MongoDB 복제 실험 오케스트레이터 (Windows PowerShell)

사용법:
  .\run.ps1 up                      레플리카셋 기동 + 초기화
  .\run.ps1 status                  현재 멤버 상태
  .\run.ps1 scenario w1-kill        시나리오 하나 실행
  .\run.ps1 all                     전체 시나리오 실행
  .\run.ps1 analyze                 결과 표 출력
  .\run.ps1 down                    정리

시나리오:
  w1-kill          w:1 로 쓰는 중에 프라이머리를 kill -9
  majority-kill    w:majority 로 같은 조건 (손실 0 이어야 함)
  w1-isolate       w:1, 프라이머리를 네트워크에서 격리 (롤백 관찰)
  stale-secondary  readPreference=secondary (read-your-writes 위반률)
  stale-primary    readPreference=primary (대조군, 0% 여야 함)

옵션:
  .\run.ps1 scenario w1-kill -KillAt 5 -RestoreAfter 20 -DurationMs 60000
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = "help",

    [Parameter(Position = 1)]
    [string]$Scenario = "",

    [int]$KillAt = 12,
    [int]$RestoreAfter = 12,
    [int]$DurationMs = 40000
)

# ---------------------------------------------------------------------------
# 중요: ErrorActionPreference 를 Stop 으로 두면 안 된다.
# Windows PowerShell 5.1 은 네이티브 명령(docker)이 stderr 로 뭔가 내보내면
# 그걸 에러 레코드로 만들고, Stop 정책이 그걸 종료 에러로 승격시킨다.
# docker 는 정상 진행 메시지도 stderr 로 내보내기 때문에 멀쩡한 실행이 죽는다.
# ---------------------------------------------------------------------------
$ErrorActionPreference = "Continue"

# PowerShell 7.4+ 에서 네이티브 비-0 종료코드가 예외가 되는 것도 끈다.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $global:PSNativeCommandUseErrorActionPreference = $false
}

Set-Location -Path $PSScriptRoot

function Write-Log {
    param([string]$Message)
    Write-Host ""
    Write-Host "=== $Message" -ForegroundColor Cyan
}

# docker 를 실행하고 stdout+stderr 를 문자열 배열로 돌려준다.
# 2>&1 로 합쳐야 stderr 가 PowerShell 에러 스트림으로 새지 않는다.
function Invoke-Docker {
    param([string[]]$DockerArgs, [switch]$Show)
    $lines = & docker @DockerArgs 2>&1 | ForEach-Object { "$_" }
    if ($Show) { $lines | ForEach-Object { Write-Host $_ } }
    return $lines
}

# app 컨테이너에서 node 스크립트 실행
function Invoke-App {
    param([string[]]$NodeArgs, [switch]$Show)
    $a = @("compose", "run", "--rm", "-T", "app", "node") + $NodeArgs
    return Invoke-Docker -DockerArgs $a -Show:$Show
}

function Get-ServiceName {
    param([string]$HostPort)          # "mongo2:27017" -> "mongo2"
    return ($HostPort -split ":")[0]
}

function Get-ContainerName {
    param([string]$HostPort)          # "mongo2:27017" -> "rs-mongo2"
    return "rs-" + (Get-ServiceName $HostPort)
}

function Get-RsNetName {
    $lines = Invoke-Docker -DockerArgs @("network", "ls", "--format", "{{.Name}}")
    $net = $lines | Where-Object { $_ -match "rsnet$" } | Select-Object -First 1
    if (-not $net) { throw "rsnet 네트워크를 찾을 수 없음. .\run.ps1 up 을 먼저 실행할 것." }
    return $net.Trim()
}

# 출력 줄들 중에서 "host:port" 모양인 줄을 찾는다 (docker 잡음 무시)
function Get-Primary {
    $out = Invoke-App @("src/rs-tools.js", "primary")
    $hit = $out | Where-Object { $_.Trim() -match "^[A-Za-z0-9_.-]+:[0-9]+$" } | Select-Object -First 1
    if (-not $hit) {
        $out | ForEach-Object { Write-Host $_ }
        throw "프라이머리를 찾을 수 없음"
    }
    return $hit.Trim()
}

function Wait-Ready {
    $out = Invoke-App @("src/rs-tools.js", "wait")
    $hit = $out | Where-Object { $_ -match "ready:" } | Select-Object -First 1
    if (-not $hit) {
        $out | ForEach-Object { Write-Host $_ }
        throw "레플리카셋이 준비되지 않음"
    }
    return ($hit -replace ".*(ready:.*)", '$1').Trim()
}

# ---------------- 명령 ----------------

function Cmd-Up {
    Write-Log "레플리카셋 기동"
    Invoke-Docker -DockerArgs @("compose", "up", "-d", "mongo1", "mongo2", "mongo3") -Show | Out-Null

    Write-Log "레플리카셋 초기화"
    Invoke-Docker -DockerArgs @("compose", "up", "rs-init") -Show | Out-Null

    Write-Log "app 이미지 빌드"
    Invoke-Docker -DockerArgs @("compose", "build", "app") -Show | Out-Null

    Write-Log "준비 대기"
    $r = Wait-Ready
    Write-Host "  $r" -ForegroundColor Green
}

function Cmd-Status {
    Invoke-App @("src/rs-tools.js", "status") -Show | Out-Null
}

# ---- 페일오버 시나리오 ----
function Invoke-FailoverScenario {
    param([string]$Label, [string]$Wc, [string]$Mode)

    Write-Log "[$Label] 시작  writeConcern=$Wc  mode=$Mode"
    Wait-Ready | Out-Null

    $before = Get-Primary
    Write-Host "  시작 시점 프라이머리: $before"

    # writer 를 별도 프로세스로 띄운다 (-NoNewWindow 라 출력이 그대로 흐른다)
    $dockerArgs = @(
        "compose", "run", "--rm", "-T",
        "-e", "LABEL=$Label",
        "-e", "WC=$Wc",
        "-e", "DURATION_MS=$DurationMs",
        "app", "node", "src/writer.js"
    )
    $writer = Start-Process -FilePath "docker" -ArgumentList $dockerArgs -NoNewWindow -PassThru

    Start-Sleep -Seconds $KillAt

    $primary   = Get-Primary
    $container = Get-ContainerName $primary
    $svc       = Get-ServiceName $primary

    Write-Host ""
    Write-Host ("  [t={0}s] 프라이머리 {1} -> {2}" -f $KillAt, $container, $Mode) -ForegroundColor Yellow

    if ($Mode -eq "kill") {
        Invoke-Docker -DockerArgs @("kill", $container) | Out-Null
    } else {
        Invoke-Docker -DockerArgs @("network", "disconnect", (Get-RsNetName), $container) | Out-Null
    }

    Start-Sleep -Seconds $RestoreAfter
    $t = $KillAt + $RestoreAfter
    Write-Host ("  [t={0}s] {1} 복구" -f $t, $container) -ForegroundColor Yellow

    if ($Mode -eq "kill") {
        Invoke-Docker -DockerArgs @("start", $container) | Out-Null
    } else {
        # --alias 를 줘야 다른 노드들이 예전 호스트명으로 다시 찾을 수 있다
        Invoke-Docker -DockerArgs @("network", "connect", "--alias", $svc, (Get-RsNetName), $container) | Out-Null
    }

    Write-Host "  writer 종료 대기..."
    $writer.WaitForExit()

    Write-Log "[$Label] 안정화 대기 (롤백이 여기서 일어난다)"
    Wait-Ready | Out-Null
    Start-Sleep -Seconds 5

    Write-Log "[$Label] 검증"
    Invoke-Docker -DockerArgs @("compose", "run", "--rm", "-T", "-e", "LABEL=$Label", "app", "node", "src/verify.js") -Show | Out-Null
}

# ---- stale read 시나리오 ----
function Invoke-StaleScenario {
    param([string]$Label, [string]$Pref)

    Write-Log "[$Label] 시작  readPreference=$Pref"
    Wait-Ready | Out-Null
    Invoke-Docker -DockerArgs @(
        "compose", "run", "--rm", "-T",
        "-e", "LABEL=$Label",
        "-e", "READ_PREF=$Pref",
        "app", "node", "src/stale-read.js"
    ) -Show | Out-Null
}

function Cmd-Scenario {
    param([string]$Name)
    switch ($Name) {
        "w1-kill"         { Invoke-FailoverScenario -Label "w1-kill"         -Wc "1"        -Mode "kill" }
        "majority-kill"   { Invoke-FailoverScenario -Label "majority-kill"   -Wc "majority" -Mode "kill" }
        "w1-isolate"      { Invoke-FailoverScenario -Label "w1-isolate"      -Wc "1"        -Mode "isolate" }
        "stale-secondary" { Invoke-StaleScenario    -Label "stale-secondary" -Pref "secondary" }
        "stale-primary"   { Invoke-StaleScenario    -Label "stale-primary"   -Pref "primary" }
        default {
            Write-Host "알 수 없는 시나리오: $Name" -ForegroundColor Red
            Write-Host "가능한 값: w1-kill, majority-kill, w1-isolate, stale-secondary, stale-primary"
            exit 1
        }
    }
}

function Cmd-All {
    foreach ($s in @("w1-kill", "majority-kill", "w1-isolate", "stale-secondary", "stale-primary")) {
        Cmd-Scenario $s
        Start-Sleep -Seconds 3
    }
    Cmd-Analyze
}

function Cmd-Analyze {
    Write-Log "결과"
    Invoke-App @("src/analyze.js") -Show | Out-Null
}

function Cmd-Down {
    Invoke-Docker -DockerArgs @("compose", "down", "-v") -Show | Out-Null
}

function Cmd-Help {
    Get-Content $PSCommandPath | Select-Object -Skip 1 -First 20 | ForEach-Object { Write-Host $_ }
}

switch ($Command) {
    "up"       { Cmd-Up }
    "status"   { Cmd-Status }
    "scenario" {
        if (-not $Scenario) {
            Write-Host "시나리오 이름이 필요해. 예: .\run.ps1 scenario w1-kill" -ForegroundColor Red
            exit 1
        }
        Cmd-Scenario $Scenario
    }
    "all"      { Cmd-All }
    "analyze"  { Cmd-Analyze }
    "down"     { Cmd-Down }
    default    { Cmd-Help }
}
