<#
.SYNOPSIS
    企业内网测速系统 - PowerShell 一键启动脚本
    用法: .\start.ps1 [-Port 8080] [-Password "yourpass"]
#>

param(
    [string]$Port = "8080",
    [string]$Password = ""
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir
$Host.UI.RawUI.WindowTitle = "企业内网测速系统 v2.0"

function Write-Color($Text, $Color = "White", $NoNewline = $false) {
    if ($NoNewline) { Write-Host $Text -ForegroundColor $Color -NoNewline }
    else { Write-Host $Text -ForegroundColor $Color }
}

Clear-Host
Write-Color "================================================" "Magenta"
Write-Color "   企业内网测速系统 - Enterprise v2.0" "Magenta"
Write-Color "================================================" "Magenta"
Write-Host ""

# [1] 检测 Node.js
Write-Color "[1/4] 检测 Node.js 环境..." "Yellow"
try {
    $nodeVer = & node -v
    Write-Color "  OK Node.js $nodeVer" "Green"
} catch {
    Write-Color "  FAIL 未检测到 Node.js" "Red"
    Write-Host "  请从 https://nodejs.org/ 安装"
    Read-Host "按回车键退出"
    exit 1
}

# [2] 安装依赖
Write-Color "[2/4] 检查项目依赖..." "Yellow"
if (-not (Test-Path "node_modules")) {
    Write-Host "   正在安装依赖..."
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Write-Color "  FAIL 依赖安装失败" "Red"
        Read-Host "按回车键退出"; exit 1
    }
    Write-Color "  OK 依赖安装完成" "Green"
} else {
    Write-Color "  OK 依赖已就绪" "Green"
}

# [3] 清理旧进程
Write-Color "[3/4] 清理已有 Node.js 进程..." "Yellow"
try {
    $procs = Get-Process node -ErrorAction Stop
    $procs | Stop-Process -Force
    Write-Color "  OK 已停止 $($procs.Count) 个旧进程" "Green"
} catch {
    Write-Color "  OK 未检测到运行中的服务" "Green"
}
$env:PORT = $Port

# [4] 获取 IP
Write-Color "[4/4] 获取本机 IP..." "Yellow"
$ips = @()
try {
    $ips = [System.Net.Dns]::GetHostEntry([System.Net.Dns]::GetHostName()).AddressList |
        Where-Object { $_.AddressFamily -eq "InterNetwork" -and $_.ToString() -ne "127.0.0.1" } |
        ForEach-Object { $_.ToString() }
} catch {}

if ($Password) { $env:ADMIN_PASSWORD = $Password }

Start-Sleep -Milliseconds 300
Clear-Host

Write-Color "================================================" "Magenta"
Write-Color "   企业内网测速系统 - Enterprise v2.0" "Magenta"
Write-Color "================================================" "Magenta"
Write-Host ""
Write-Color "  正在启动服务器..." "Green" ""
Write-Color "  访问地址:" "Blue"
Write-Color "    http://localhost:$env:PORT" "Cyan"
foreach ($ip in $ips) { if ($ip) { Write-Color "    http://$ip`:$env:PORT" "Cyan" } }
Write-Host ""
Write-Color "  管理后台: " "Blue" -NoNewline
Write-Color "http://localhost:$env:PORT/console/dashboard.html" "Cyan"
Write-Color "  默认密码: " "Blue" -NoNewline
if ($Password) { Write-Color "(自定义)" "Green" }
else { Write-Color "admin123" "Yellow" }
Write-Host "`n"
Write-Color "  按 Ctrl+C 停止服务器" "Gray"
Write-Host ""

try { & node server.js }
catch { Write-Color "`n服务器异常退出: $_" "Red" }
Read-Host "按回车键退出"
