# server.ps1
# A lightweight local web server and CORS proxy for ARSO water data

$port = 8082
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")

try {
    $listener.Start()
    Write-Host "============================================="
    Write-Host " Slovenian Sea Level Tracker Server Active "
    Write-Host " Address: http://localhost:$port/           "
    Write-Host " Press Ctrl+C in this window to stop.        "
    Write-Host "============================================="
} catch {
    Write-Host "CRITICAL: Failed to start web server on port ${port}. Error: $_"
    Write-Host "Make sure no other server is running on this port."
    Exit
}

$currentDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($currentDir)) {
    $currentDir = Get-Location
}
Write-Host "Serving static files from: $currentDir"

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        
        $localPath = $request.Url.LocalPath
        Write-Host "$($request.HttpMethod) $localPath"
        
        # Enable CORS and disable caching for all local requests
        $response.Headers.Add("Access-Control-Allow-Origin", "*")
        $response.Headers.Add("Access-Control-Allow-Methods", "GET, OPTIONS")
        $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
        $response.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate")
        $response.Headers.Add("Pragma", "no-cache")
        $response.Headers.Add("Expires", "0")
        
        if ($request.HttpMethod -eq "OPTIONS") {
            $response.StatusCode = 200
            $response.Close()
            continue
        }
        
        if ($localPath -eq "/api/data") {
            # Handle API proxy fetch for ARSO table data
            $period = $request.QueryString["period"]
            if ($period -ne "7" -and $period -ne "30") {
                $period = "1"
            }
            
            $epoch = [int]([DateTimeOffset]::Now.ToUnixTimeSeconds())
            $arsoUrl = "https://www.arso.gov.si/vode/podatki/amp/H9350_t_${period}.html?cb=$epoch"
            Write-Host "Proxy fetching ARSO: $arsoUrl"
            
            try {
                $webRequest = [System.Net.HttpWebRequest]::Create($arsoUrl)
                $webRequest.Timeout = 10000 # 10 seconds timeout
                $webRequest.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                $webResponse = $webRequest.GetResponse()
                $reader = New-Object System.IO.StreamReader($webResponse.GetResponseStream(), [System.Text.Encoding]::UTF8)
                $html = $reader.ReadToEnd()
                $reader.Close()
                $webResponse.Close()
                
                # Extract measurements using regular expressions
                # Expecting format:
                # <tr>
                # <td>dd.mm.yyyy hh:mm</td>
                # <td>temperature</td>
                # <td>sea_level</td>
                # </tr>
                $pattern = '(?si)<tr>\s*<td>\s*(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})\s*</td>\s*<td>\s*([0-9\.\-]+)\s*</td>\s*<td>\s*([0-9\.\-]+)\s*</td>\s*</tr>'
                $matches = [regex]::Matches($html, $pattern)
                
                $dataList = New-Object System.Collections.ArrayList
                foreach ($m in $matches) {
                    $timeStr = $m.Groups[1].Value.Trim()
                    $tempVal = 0.0
                    $levelVal = 0.0
                    
                    $hasTemp = [double]::TryParse($m.Groups[2].Value.Trim(), [System.Globalization.NumberStyles]::Any, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$tempVal)
                    $hasLevel = [double]::TryParse($m.Groups[3].Value.Trim(), [System.Globalization.NumberStyles]::Any, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$levelVal)
                    
                    if ($hasLevel) {
                        $item = @{
                            time = $timeStr
                            temp = if ($hasTemp) { $tempVal } else { $null }
                            level = $levelVal
                        }
                        $dataList.Add($item) | Out-Null
                    }
                }
                
                $json = ConvertTo-Json $dataList
                $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
                
                $response.ContentType = "application/json; charset=utf-8"
                $response.ContentLength64 = $buffer.Length
                $response.OutputStream.Write($buffer, 0, $buffer.Length)
            } catch {
                Write-Host "ERROR fetching/parsing ARSO data: $_"
                $response.StatusCode = 500
                $errObj = @{ error = "Failed to load water data from ARSO: $_" }
                $json = ConvertTo-Json $errObj
                $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
                $response.ContentType = "application/json; charset=utf-8"
                $response.OutputStream.Write($buffer, 0, $buffer.Length)
            }
            $response.Close()
        } else {
            # Serve static files locally
            $cleanPath = $localPath.TrimStart('/').Replace('/', '\')
            if ([string]::IsNullOrEmpty($cleanPath)) {
                $cleanPath = "index.html"
            }
            
            $filePath = Join-Path $currentDir $cleanPath
            
            if (Test-Path $filePath -PathType Leaf) {
                # Mime type selection
                $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
                $contentType = "text/plain"
                if ($ext -eq ".html") { $contentType = "text/html; charset=utf-8" }
                elseif ($ext -eq ".css") { $contentType = "text/css; charset=utf-8" }
                elseif ($ext -eq ".js") { $contentType = "application/javascript; charset=utf-8" }
                elseif ($ext -eq ".json") { $contentType = "application/json; charset=utf-8" }
                elseif ($ext -eq ".svg") { $contentType = "image/svg+xml; charset=utf-8" }
                elseif ($ext -eq ".png") { $contentType = "image/png" }
                elseif ($ext -eq ".gif") { $contentType = "image/gif" }
                elseif ($ext -eq ".jpg" -or $ext -eq ".jpeg") { $contentType = "image/jpeg" }
                
                $buffer = [System.IO.File]::ReadAllBytes($filePath)
                $response.ContentType = $contentType
                $response.ContentLength64 = $buffer.Length
                $response.OutputStream.Write($buffer, 0, $buffer.Length)
            } else {
                $response.StatusCode = 404
                $buffer = [System.Text.Encoding]::UTF8.GetBytes("File Not Found: $localPath")
                $response.OutputStream.Write($buffer, 0, $buffer.Length)
            }
            $response.Close()
        }
    } catch {
        # Catch listener errors or context closing exceptions
        if ($_.Exception -is [System.Net.HttpListenerException]) {
            # Normal listener shutdown
            break
        }
        Write-Host "Error serving context: $_"
    }
}
