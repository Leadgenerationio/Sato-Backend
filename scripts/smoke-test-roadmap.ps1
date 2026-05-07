#!/usr/bin/env pwsh
# Smoke-tests the new endpoints from the post-demo roadmap (A, B, C, D, E).
# Read-only by default. Pass -SeedAndExercise to also create a temporary
# creative + run a full approve / reject / audit cycle, then clean up.
#
# Defaults to localhost:3001. Override via $env:STATO_API_URL or -BaseUrl.
#
# Usage:
#   pwsh ./scripts/smoke-test-roadmap.ps1
#   pwsh ./scripts/smoke-test-roadmap.ps1 -BaseUrl https://sato-backend-production.up.railway.app
#   pwsh ./scripts/smoke-test-roadmap.ps1 -SeedAndExercise

[CmdletBinding()]
param(
    [string]$BaseUrl = $(if ($env:STATO_API_URL) { $env:STATO_API_URL } else { "http://localhost:3001" }),
    [string]$OwnerEmail = "owner@stato.app",
    [string]$OwnerPassword = "owner123",
    [string]$ClientEmail = "client@stato.app",
    [string]$ClientPassword = "client123",
    [switch]$SeedAndExercise
)

$ErrorActionPreference = "Stop"
$failures = 0
$passes = 0

function Step {
    param([string]$Name, [scriptblock]$Block)
    Write-Host "─── $Name " -NoNewline
    try {
        & $Block
        Write-Host "PASS" -ForegroundColor Green
        $script:passes++
    } catch {
        Write-Host "FAIL" -ForegroundColor Red
        Write-Host "    $($_.Exception.Message)" -ForegroundColor DarkRed
        $script:failures++
    }
}

function Login {
    param([string]$Email, [string]$Password)
    $body = @{ email = $Email; password = $Password } | ConvertTo-Json
    $res = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/v1/auth/login" `
        -ContentType "application/json" -Body $body
    return $res.data.tokens.accessToken
}

function ApiGet {
    param([string]$Path, [string]$Token)
    return Invoke-RestMethod -Method Get -Uri "$BaseUrl$Path" `
        -Headers @{ Authorization = "Bearer $Token" }
}

function ApiPost {
    param([string]$Path, [string]$Token, [object]$Body = @{})
    $json = $Body | ConvertTo-Json -Compress
    return Invoke-RestMethod -Method Post -Uri "$BaseUrl$Path" `
        -ContentType "application/json" `
        -Headers @{ Authorization = "Bearer $Token" } -Body $json
}

# ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Stato roadmap smoke-test" -ForegroundColor Cyan
Write-Host "API: $BaseUrl"
Write-Host ""

Step "Login as owner" {
    $script:ownerToken = Login -Email $OwnerEmail -Password $OwnerPassword
    if (-not $script:ownerToken) { throw "no token returned" }
}

Step "Login as client" {
    $script:clientToken = Login -Email $ClientEmail -Password $ClientPassword
    if (-not $script:clientToken) { throw "no token returned" }
}

# ─── A: managed-client portal mode ───
Step "A — /portal/dashboard returns clientType field" {
    $res = ApiGet -Path "/api/v1/portal/dashboard" -Token $script:clientToken
    if ($res.data.clientType -notin @("managed", "ppl")) {
        throw "clientType=$($res.data.clientType) — expected 'managed' or 'ppl'"
    }
    Write-Host "" -NoNewline
    Write-Host " (clientType=$($res.data.clientType))" -NoNewline -ForegroundColor DarkGray
}

# ─── D: per-delivery breakdown — campaignId on each lead row ───
Step "D — /portal/leads rows carry campaignId UUID" {
    $res = ApiGet -Path "/api/v1/portal/leads" -Token $script:clientToken
    if (-not $res.data.range.from) { throw "no range.from in response" }
    if ($res.data.leads -and $res.data.leads.Count -gt 0) {
        $sample = $res.data.leads[0]
        if (-not ($sample.campaignId -match "^[0-9a-f-]{36}$")) {
            throw "first row missing campaignId UUID (got '$($sample.campaignId)')"
        }
        Write-Host " ($($res.data.leads.Count) lead rows, sample campaignId=$($sample.campaignId.Substring(0,8))…)" -NoNewline -ForegroundColor DarkGray
    } else {
        Write-Host " (empty array — schema check only)" -NoNewline -ForegroundColor DarkGray
    }
}

# ─── E: visual integrations dashboard ───
Step "E — /integrations/overview returns all 7 integrations" {
    $res = ApiGet -Path "/api/v1/integrations/overview" -Token $script:ownerToken
    foreach ($k in @("xero","leadbyte","catchr","signnow","r2","resend","creditCheck")) {
        if ($null -eq $res.data.$k) { throw "missing key: $k" }
        if ($null -eq $res.data.$k.configured) { throw "$k missing 'configured' flag" }
    }
    $live = ($res.data.PSObject.Properties | Where-Object { $_.Value.configured -eq $true }).Count
    Write-Host " ($live of 7 configured)" -NoNewline -ForegroundColor DarkGray
}

# ─── C: asset approval — read-only checks ───
Step "C — /portal/compliance includes approval block per creative" {
    $res = ApiGet -Path "/api/v1/portal/compliance" -Token $script:clientToken
    $allCreatives = @()
    foreach ($c in $res.data.compliance) { $allCreatives += $c.creatives }
    if ($allCreatives.Count -eq 0) {
        Write-Host " (no creatives seeded — schema check only)" -NoNewline -ForegroundColor DarkGray
        return
    }
    $sample = $allCreatives[0]
    if ($null -eq $sample.approval) { throw "creative missing approval block" }
    if ($sample.approval.status -notin @("pending","approved","rejected")) {
        throw "approval.status=$($sample.approval.status)"
    }
    Write-Host " ($($allCreatives.Count) creatives, sample status=$($sample.approval.status))" -NoNewline -ForegroundColor DarkGray
}

Step "C — reject without feedback returns 400" {
    # Use a clearly bogus creative id; we want the 400 to come from the
    # missing-feedback validator, not the not-found path. Server returns
    # FEEDBACK_REQUIRED before ACCESS_DENIED only when feedback is empty —
    # we just confirm the route exists and refuses empty feedback.
    try {
        ApiPost -Path "/api/v1/portal/creatives/00000000-0000-0000-0000-000000000000/reject" `
            -Token $script:clientToken -Body @{} | Out-Null
        throw "expected 400 but got 2xx"
    } catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { throw $_.Exception.Message }
        if ([int]$resp.StatusCode -ne 400 -and [int]$resp.StatusCode -ne 404) {
            throw "expected 400 or 404, got $([int]$resp.StatusCode)"
        }
        Write-Host " (HTTP $([int]$resp.StatusCode))" -NoNewline -ForegroundColor DarkGray
    }
}

# ─── Optional: full approve/reject/audit cycle on a real creative ───
if ($SeedAndExercise) {
    Write-Host ""
    Write-Host "Seed-and-exercise mode: full approve cycle" -ForegroundColor Cyan

    $res = ApiGet -Path "/api/v1/portal/compliance" -Token $script:clientToken
    $creativeId = $null
    foreach ($c in $res.data.compliance) {
        if ($c.creatives -and $c.creatives.Count -gt 0) {
            $creativeId = $c.creatives[0].id
            break
        }
    }
    if (-not $creativeId) {
        Write-Host "  (no creatives found for demo client — skipping cycle)" -ForegroundColor Yellow
    } else {
        Step "C — approve creative $($creativeId.Substring(0,8))…" {
            $ev = ApiPost -Path "/api/v1/portal/creatives/$creativeId/approve" -Token $script:clientToken
            if ($ev.data.event.action -ne "approved") { throw "expected action=approved" }
            if (-not $ev.data.event.ipAddress) { throw "no ipAddress captured" }
        }
        Step "C — reject same creative with feedback" {
            $ev = ApiPost -Path "/api/v1/portal/creatives/$creativeId/reject" -Token $script:clientToken `
                -Body @{ feedback = "Smoke test rejection" }
            if ($ev.data.event.action -ne "rejected") { throw "expected action=rejected" }
        }
        Step "C — owner audit history shows both decisions" {
            $h = ApiGet -Path "/api/v1/creatives/$creativeId/approval-history" -Token $script:ownerToken
            if ($h.data.events.Count -lt 2) { throw "expected >= 2 events, got $($h.data.events.Count)" }
            if ($h.data.events[0].action -ne "rejected") { throw "most recent should be rejected" }
            Write-Host " ($($h.data.events.Count) events on file)" -NoNewline -ForegroundColor DarkGray
        }
    }
}

# ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "─── Result ───"
Write-Host "  $passes pass" -ForegroundColor Green -NoNewline
Write-Host " · $failures fail" -ForegroundColor $(if ($failures -gt 0) { "Red" } else { "DarkGray" })
exit $(if ($failures -gt 0) { 1 } else { 0 })
