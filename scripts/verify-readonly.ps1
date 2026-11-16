# NekoShelf 只读审计：确认扫描/阅读不写、不改名媒体目录
#
# 用途：对指定样本目录做「扫描/阅读前后」的文件清单 + SHA256 对比，
# 证明服务端只读源：不新增、不删除、不改名、不修改内容（不含被明确开启的写回）。
#
# 用法：
#   pwsh scripts/verify-readonly.ps1 -Path "<媒体库根>" -Sample <库路径>
#   pwsh scripts/verify-readonly.ps1 -Path "<样本目录>" -Top 200
#
# 注意：
# - 扫 NAS 时只做「枚举 + hash」不做递归全库；默认取前 Top 个文件，避免把 SMB 读卡死；
# - 只对文件算 hash，目录只记路径；跳过下载中临时扩展名（.part/.pptd/.tmp）。
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$Top = 200,
  [string]$ReportDir = ".tmp-readonly-audit"
)

$ErrorActionPreference = "Stop"

$skipExt = @(".part", ".pptd", ".tmp", ".downloading", ".aria2", ".!qb")

function Snapshot([string]$root, [int]$top) {
  $files = Get-ChildItem -LiteralPath $root -Recurse -File -Force |
    Where-Object { $skipExt -notcontains $_.Extension.ToLowerInvariant() } |
    Select-Object -First $top
  $rows = foreach ($f in $files) {
    $hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
    [pscustomobject]@{
      Relative = $f.FullName.Substring($root.Length).TrimStart('\', '/')
      Bytes    = $f.Length
      Modified = $f.LastWriteTimeUtc.ToString("o")
      Sha256   = $hash
    }
  }
  return @($rows)
}

New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$before = Snapshot -root $Path -top $Top
$before | Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $ReportDir "before-$stamp.csv")

Write-Host "已记录 $($before.Count) 个文件的基线（$ReportDir/before-$stamp.csv）。"
Write-Host "现在去 Web 里对这个库跑一次扫描 / 打开几个作品，然后回来按回车继续对比…"
Read-Host | Out-Null

$after = Snapshot -root $Path -top $Top
$after | Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $ReportDir "after-$stamp.csv")

$beforeMap = @{}
foreach ($row in $before) { $beforeMap[$row.Relative] = $row }

$problems = @()
foreach ($row in $after) {
  if (-not $beforeMap.ContainsKey($row.Relative)) {
    $problems += "新增：$($row.Relative)"
    continue
  }
  $old = $beforeMap[$row.Relative]
  if ($old.Sha256 -ne $row.Sha256) { $problems += "内容变化：$($row.Relative)" }
  if ($old.Bytes -ne $row.Bytes) { $problems += "大小变化：$($row.Relative)" }
  $beforeMap.Remove($row.Relative)
}
foreach ($remaining in $beforeMap.Keys) { $problems += "消失：$remaining" }

if ($problems.Count -eq 0) {
  Write-Host "PASS：$($after.Count) 个文件前后完全一致（未新增/删除/修改）。" -ForegroundColor Green
  exit 0
}
$problems | ForEach-Object { Write-Host "FAIL：$_" -ForegroundColor Red }
exit 1
