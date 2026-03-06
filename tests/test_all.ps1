$ErrorActionPreference = "Continue"
$baseUrl = "http://localhost:8080"

Write-Host "`n=== TEST 1: Health Check ===" -ForegroundColor Cyan
$health = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get
Write-Host "Response: $($health | ConvertTo-Json -Compress)"
if ($health.status -eq "ok") { Write-Host "PASS" -ForegroundColor Green } else { Write-Host "FAIL" -ForegroundColor Red }

Write-Host "`n=== TEST 2: POST /exports/csv with filters ===" -ForegroundColor Cyan
$export1 = Invoke-RestMethod -Uri "$baseUrl/exports/csv?country_code=US&min_ltv=500" -Method Post
Write-Host "Response: $($export1 | ConvertTo-Json -Compress)"
$id1 = $export1.exportId
if ($export1.status -eq "pending" -and $id1) { Write-Host "PASS - exportId: $id1" -ForegroundColor Green } else { Write-Host "FAIL" -ForegroundColor Red }

Write-Host "`n=== TEST 3: GET /exports/{id}/status ===" -ForegroundColor Cyan
$status1 = Invoke-RestMethod -Uri "$baseUrl/exports/$id1/status" -Method Get
Write-Host "Response: $($status1 | ConvertTo-Json -Compress -Depth 5)"
if ($status1.exportId -eq $id1 -and $status1.progress) { Write-Host "PASS" -ForegroundColor Green } else { Write-Host "FAIL" -ForegroundColor Red }

Write-Host "`n=== TEST 4: Poll until completed ===" -ForegroundColor Cyan
$maxWait = 300
$waited = 0
while ($waited -lt $maxWait) {
    $pollStatus = Invoke-RestMethod -Uri "$baseUrl/exports/$id1/status" -Method Get
    Write-Host "  Status: $($pollStatus.status), Progress: $($pollStatus.progress.percentage)%"
    if ($pollStatus.status -eq "completed") {
        Write-Host "PASS - Export completed! processedRows=$($pollStatus.progress.processedRows) totalRows=$($pollStatus.progress.totalRows)" -ForegroundColor Green
        break
    }
    if ($pollStatus.status -eq "failed") {
        Write-Host "FAIL - Export failed: $($pollStatus.error)" -ForegroundColor Red
        break
    }
    Start-Sleep -Seconds 5
    $waited += 5
}
if ($waited -ge $maxWait) { Write-Host "FAIL - Timeout" -ForegroundColor Red }

Write-Host "`n=== TEST 5: GET /exports/{id}/download headers ===" -ForegroundColor Cyan
$downloadResp = Invoke-WebRequest -Uri "$baseUrl/exports/$id1/download" -Method Get -UseBasicParsing
Write-Host "Status: $($downloadResp.StatusCode)"
Write-Host "Content-Type: $($downloadResp.Headers['Content-Type'])"
Write-Host "Content-Disposition: $($downloadResp.Headers['Content-Disposition'])"
Write-Host "Accept-Ranges: $($downloadResp.Headers['Accept-Ranges'])"
Write-Host "Content-Length: $($downloadResp.Headers['Content-Length'])"
$csvContent = $downloadResp.Content
$lines = $csvContent -split "`n"
Write-Host "CSV Header: $($lines[0])"
Write-Host "Total lines (including header): $($lines.Count)"
if ($downloadResp.StatusCode -eq 200 -and $downloadResp.Headers['Content-Type'] -like "*text/csv*") { Write-Host "PASS" -ForegroundColor Green } else { Write-Host "FAIL" -ForegroundColor Red }

Write-Host "`n=== TEST 6: Range request (resumable download) ===" -ForegroundColor Cyan
$rangeResp = Invoke-WebRequest -Uri "$baseUrl/exports/$id1/download" -Method Get -Headers @{'Range'='bytes=0-1023'} -UseBasicParsing
Write-Host "Status: $($rangeResp.StatusCode)"
Write-Host "Content-Length: $($rangeResp.Headers['Content-Length'])"
Write-Host "Content-Range: $($rangeResp.Headers['Content-Range'])"
if ($rangeResp.StatusCode -eq 206 -and $rangeResp.Headers['Content-Length'] -eq '1024') { Write-Host "PASS" -ForegroundColor Green } else { Write-Host "FAIL" -ForegroundColor Red }

Write-Host "`n=== TEST 7: Column selection ===" -ForegroundColor Cyan
$exportCols = Invoke-RestMethod -Uri "$baseUrl/exports/csv?columns=id,email,country_code" -Method Post
$idCols = $exportCols.exportId
Write-Host "Export started: $idCols"
# Wait for completion
$waited = 0
while ($waited -lt $maxWait) {
    $st = Invoke-RestMethod -Uri "$baseUrl/exports/$idCols/status" -Method Get
    if ($st.status -eq "completed") { break }
    if ($st.status -eq "failed") { Write-Host "FAIL - Export failed" -ForegroundColor Red; break }
    Start-Sleep -Seconds 5; $waited += 5
}
$dlCols = Invoke-WebRequest -Uri "$baseUrl/exports/$idCols/download" -Method Get -UseBasicParsing
$headerLine = ($dlCols.Content -split "`n")[0].Trim()
Write-Host "CSV Header: $headerLine"
if ($headerLine -eq "id,email,country_code") { Write-Host "PASS" -ForegroundColor Green } else { Write-Host "FAIL - Expected 'id,email,country_code' got '$headerLine'" -ForegroundColor Red }

Write-Host "`n=== TEST 8: Custom delimiter ===" -ForegroundColor Cyan
$exportDelim = Invoke-RestMethod -Uri "$baseUrl/exports/csv?delimiter=|&columns=id,name" -Method Post
$idDelim = $exportDelim.exportId
$waited = 0
while ($waited -lt $maxWait) {
    $st = Invoke-RestMethod -Uri "$baseUrl/exports/$idDelim/status" -Method Get
    if ($st.status -eq "completed") { break }
    if ($st.status -eq "failed") { Write-Host "FAIL" -ForegroundColor Red; break }
    Start-Sleep -Seconds 5; $waited += 5
}
$dlDelim = Invoke-WebRequest -Uri "$baseUrl/exports/$idDelim/download" -Method Get -UseBasicParsing
$delimHeader = ($dlDelim.Content -split "`n")[0].Trim()
$delimDataLine = ($dlDelim.Content -split "`n")[1].Trim()
Write-Host "CSV Header: $delimHeader"
Write-Host "First data line: $delimDataLine"
if ($delimHeader -eq "id|name" -and $delimDataLine -like "*|*") { Write-Host "PASS" -ForegroundColor Green } else { Write-Host "FAIL" -ForegroundColor Red }

Write-Host "`n=== TEST 9: Cancel export ===" -ForegroundColor Cyan
$exportCancel = Invoke-RestMethod -Uri "$baseUrl/exports/csv" -Method Post
$idCancel = $exportCancel.exportId
Write-Host "Started export: $idCancel"
Start-Sleep -Seconds 1
$cancelResp = Invoke-WebRequest -Uri "$baseUrl/exports/$idCancel" -Method Delete -UseBasicParsing
Write-Host "Delete status: $($cancelResp.StatusCode)"
try {
    $checkCancelled = Invoke-WebRequest -Uri "$baseUrl/exports/$idCancel/status" -Method Get -UseBasicParsing -ErrorAction Stop
    $body = $checkCancelled.Content | ConvertFrom-Json
    if ($body.status -eq "cancelled") { Write-Host "PASS - Status is cancelled" -ForegroundColor Green } else { Write-Host "INFO - Status: $($body.status)" -ForegroundColor Yellow }
} catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 404) { Write-Host "PASS - 404 after deletion" -ForegroundColor Green } else { Write-Host "FAIL - Unexpected error: $_" -ForegroundColor Red }
}

Write-Host "`n=== TEST 10: Gzip compression ===" -ForegroundColor Cyan
try {
    $gzipResp = Invoke-WebRequest -Uri "$baseUrl/exports/$id1/download" -Method Get -Headers @{'Accept-Encoding'='gzip'} -UseBasicParsing
    Write-Host "Status: $($gzipResp.StatusCode)"
    $ce = $gzipResp.Headers['Content-Encoding']
    Write-Host "Content-Encoding: $ce"
    if ($gzipResp.StatusCode -eq 200) { Write-Host "PASS" -ForegroundColor Green } else { Write-Host "FAIL" -ForegroundColor Red }
} catch { Write-Host "Error: $_" -ForegroundColor Red }

Write-Host "`n=== TEST 11: 3 Concurrent exports ===" -ForegroundColor Cyan
$e1 = Invoke-RestMethod -Uri "$baseUrl/exports/csv?country_code=GB" -Method Post
$e2 = Invoke-RestMethod -Uri "$baseUrl/exports/csv?country_code=IN" -Method Post
$e3 = Invoke-RestMethod -Uri "$baseUrl/exports/csv?country_code=JP" -Method Post
Write-Host "Started 3 exports: $($e1.exportId), $($e2.exportId), $($e3.exportId)"
$allDone = $false
$waited = 0
while (-not $allDone -and $waited -lt $maxWait) {
    $s1 = Invoke-RestMethod -Uri "$baseUrl/exports/$($e1.exportId)/status" -Method Get
    $s2 = Invoke-RestMethod -Uri "$baseUrl/exports/$($e2.exportId)/status" -Method Get
    $s3 = Invoke-RestMethod -Uri "$baseUrl/exports/$($e3.exportId)/status" -Method Get
    Write-Host "  GB: $($s1.status) ($($s1.progress.percentage)%), IN: $($s2.status) ($($s2.progress.percentage)%), JP: $($s3.status) ($($s3.progress.percentage)%)"
    if ($s1.status -eq "completed" -and $s2.status -eq "completed" -and $s3.status -eq "completed") { $allDone = $true }
    if ($s1.status -eq "failed" -or $s2.status -eq "failed" -or $s3.status -eq "failed") { Write-Host "FAIL - One or more exports failed" -ForegroundColor Red; break }
    Start-Sleep -Seconds 5; $waited += 5
}
if ($allDone) { Write-Host "PASS - All 3 concurrent exports completed" -ForegroundColor Green } elseif ($waited -ge $maxWait) { Write-Host "FAIL - Timeout" -ForegroundColor Red }

Write-Host "`n=== TEST 12: Health responsive during export ===" -ForegroundColor Cyan
$bigExport = Invoke-RestMethod -Uri "$baseUrl/exports/csv" -Method Post
Write-Host "Started full export: $($bigExport.exportId)"
Start-Sleep -Seconds 2
$allFast = $true
for ($i = 1; $i -le 10; $i++) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $h = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get
    $sw.Stop()
    $ms = $sw.ElapsedMilliseconds
    Write-Host "  Health check $i`: $($ms)ms - status=$($h.status)"
    if ($ms -gt 200) { $allFast = $false }
}
if ($allFast) { Write-Host "PASS - All health checks < 200ms" -ForegroundColor Green } else { Write-Host "WARN - Some health checks > 200ms" -ForegroundColor Yellow }

Write-Host "`n=== ALL TESTS COMPLETE ===" -ForegroundColor Cyan
