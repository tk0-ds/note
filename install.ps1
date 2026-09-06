<#
  TaskChute for VS Code をこの PC にインストールする。

  使い方:
      powershell -ExecutionPolicy Bypass -File .\install.ps1

  オプション:
      -Copy            ジャンクション (フォルダの別名) ではなく、実体コピーで入れる
      -Uninstall       入れたものを取り除く
      -ExtensionsDir   VS Code の拡張機能フォルダを明示する
                       (既定: %USERPROFILE%\.vscode\extensions)

  このスクリプトが触るのは VS Code の拡張機能フォルダだけで、
  ノートやタスクのデータには一切手を入れない。
#>
[CmdletBinding()]
param(
  [string]$ExtensionsDir = (Join-Path $env:USERPROFILE '.vscode\extensions'),
  [switch]$Copy,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$name = 'local.taskchute-vscode-0.1.0'
$src = Join-Path $PSScriptRoot 'tools\vscode-taskchute'
$dst = Join-Path $ExtensionsDir $name

function Write-Step($msg) { Write-Host "  $msg" }

Write-Host ''
Write-Host 'TaskChute for VS Code'
Write-Host ('=' * 60)
Write-Step "環境フォルダ : $PSScriptRoot"
Write-Step "拡張機能の元 : $src"
Write-Step "入れ先       : $dst"
Write-Host ''

# ---- 既存を取り除く -------------------------------------------------------
if (Test-Path $dst) {
  # ジャンクションの場合、Remove-Item -Recurse はリンクだけを消す (元は残る)
  Remove-Item $dst -Force -Recurse -Confirm:$false
  Write-Step '既存のインストールを取り除いた'
}

if ($Uninstall) {
  Write-Host ''
  Write-Host 'アンインストールしました。VS Code を再起動してください。'
  Write-Host ''
  exit 0
}

# ---- 前提を確認 -----------------------------------------------------------
if (-not (Test-Path (Join-Path $src 'package.json'))) {
  Write-Error "拡張機能のソースが見つかりません: $src`nこのスクリプトは 30_note フォルダの直下に置いたまま実行してください。"
}

if (-not (Test-Path $ExtensionsDir)) {
  New-Item -ItemType Directory -Path $ExtensionsDir -Force | Out-Null
  Write-Step "拡張機能フォルダを作成: $ExtensionsDir"
}

# ---- 入れる ---------------------------------------------------------------
$method = ''
if (-not $Copy) {
  try {
    New-Item -ItemType Junction -Path $dst -Target $src -ErrorAction Stop | Out-Null
    $method = 'ジャンクション (ソースを直すと即反映される)'
  } catch {
    Write-Step "ジャンクションを作れなかったのでコピーに切り替える: $($_.Exception.Message)"
  }
}

if (-not $method) {
  Copy-Item -Path $src -Destination $dst -Recurse -Force
  $method = 'コピー (ソースを直したら install.ps1 を実行し直す)'
}

# ---- 確認 -----------------------------------------------------------------
if (-not (Test-Path (Join-Path $dst 'package.json'))) {
  Write-Error "インストールに失敗しました: $dst から package.json が読めません"
}

Write-Step "インストール方式: $method"

$code = Get-Command code -ErrorAction SilentlyContinue
if ($code) {
  $found = & $code.Source --list-extensions 2>$null | Where-Object { $_ -eq 'local.taskchute-vscode' }
  if ($found) {
    Write-Step 'VS Code が拡張機能を認識した'
  } else {
    Write-Step 'VS Code はまだ認識していない (再起動すれば読み込まれる)'
  }
}

Write-Host ''
Write-Host '完了。次にやること:'
Write-Host ''
Write-Host "  1. VS Code を再起動する (既に開いているなら Ctrl+Shift+P -> 開発者: ウィンドウの再読み込み)"
Write-Host "  2. このフォルダをワークスペースとして開く:"
Write-Host "         code `"$PSScriptRoot`""
Write-Host '  3. Ctrl+Alt+D  今日のデイリーノート'
Write-Host '     Ctrl+Alt+T  TaskChute パネル'
Write-Host ''
