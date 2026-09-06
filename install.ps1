<#
  TaskChute for VS Code をこの PC にインストールする。

  使い方:
      powershell -ExecutionPolicy Bypass -File ./install.ps1

  オプション:
      -ShowPaths       どこに入れるかだけ表示して終了する (調査用)
      -Copy            ジャンクション (フォルダの別名) ではなく、実体コピーで入れる
      -Uninstall       入れたものを取り除く
      -ExtensionsDir   VS Code の拡張機能フォルダを明示する
                       (省略時は自動判別。下の Resolve-ExtensionsDir を参照)

  このスクリプトが触るのは VS Code の拡張機能フォルダだけで、
  ノートやタスクのデータには一切手を入れない。
#>
[CmdletBinding()]
param(
  [string]$ExtensionsDir = '',
  [switch]$ShowPaths,
  [switch]$Copy,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$name = 'local.taskchute-vscode-0.1.0'
$src = Join-Path $PSScriptRoot 'tools\vscode-taskchute'

function Write-Step($msg) { Write-Host "  $msg" }

<#
  code コマンドの実体から VS Code の本体フォルダを割り出す。
  Scoop は shims\code.cmd という薄い中継を置くだけなので、
  同名の .shim ファイルに書かれた本当のパスを読む必要がある。
#>
function Resolve-CodeRoot {
  $cmd = Get-Command code -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  $p = $cmd.Source

  $shim = [System.IO.Path]::ChangeExtension($p, '.shim')
  if (Test-Path $shim) {
    $line = Get-Content $shim | Where-Object { $_ -match '^\s*path\s*=' } | Select-Object -First 1
    if ($line) { $p = ($line -split '=', 2)[1].Trim().Trim('"') }
  }

  $parent = Split-Path -Parent $p
  if (-not $parent) { return $null }
  # <本体>\bin\code.cmd という形が普通なので、bin なら 1 つ上へ
  if ((Split-Path -Leaf $parent) -eq 'bin') { return Split-Path -Parent $parent }
  return $parent
}

<#
  拡張機能フォルダを決める。
  Scoop や -portable で入れた VS Code は「ポータブル構成」になり、
  本体の隣の data\extensions を見る。標準の場所に入れても読まれない。
#>
function Resolve-ExtensionsDir {
  $cands = @()

  if ($env:VSCODE_EXTENSIONS) {
    $cands += ,@{ Path = $env:VSCODE_EXTENSIONS; Why = '環境変数 VSCODE_EXTENSIONS' }
  }
  if ($env:VSCODE_PORTABLE) {
    $cands += ,@{ Path = (Join-Path $env:VSCODE_PORTABLE 'extensions'); Why = '環境変数 VSCODE_PORTABLE' }
  }

  $root = Resolve-CodeRoot
  if ($root) {
    $cands += ,@{ Path = (Join-Path $root 'data\extensions'); Why = "ポータブル構成 ($root)" }
  }

  $cands += ,@{ Path = (Join-Path $env:USERPROFILE 'scoop\persist\vscode\data\extensions'); Why = 'Scoop の persist フォルダ' }
  $cands += ,@{ Path = (Join-Path $env:USERPROFILE 'scoop\apps\vscode\current\data\extensions'); Why = 'Scoop の apps フォルダ' }
  $cands += ,@{ Path = (Join-Path $env:USERPROFILE '.vscode\extensions'); Why = '標準の場所' }

  return $cands
}

Write-Host ''
Write-Host 'TaskChute for VS Code'
Write-Host ('=' * 62)

# ---- 入れ先を決める -------------------------------------------------------
$cands = Resolve-ExtensionsDir
$chosen = $null
$chosenWhy = ''

if ($ExtensionsDir) {
  $chosen = $ExtensionsDir
  $chosenWhy = '-ExtensionsDir で指定'
} else {
  # 既に存在しているものを優先する。VS Code が実際に使っている場所には
  # 他の拡張機能が入っているはずなので、それが一番確かな手がかりになる。
  foreach ($c in $cands) {
    if (Test-Path $c.Path) { $chosen = $c.Path; $chosenWhy = $c.Why; break }
  }
  if (-not $chosen) {
    $last = $cands[$cands.Count - 1]
    $chosen = $last.Path
    $chosenWhy = $last.Why + ' (候補がどれも無いので既定)'
  }
}

if ($ShowPaths) {
  Write-Host ''
  Write-Host '  code コマンド:'
  $cmd = Get-Command code -ErrorAction SilentlyContinue
  if ($cmd) { Write-Step "  $($cmd.Source)" } else { Write-Step '  見つかりません (PATH に code がない)' }
  $root = Resolve-CodeRoot
  if ($root) { Write-Step "  本体フォルダ: $root" }
  Write-Host ''
  Write-Host '  拡張機能フォルダの候補 (上から順に探し、最初に見つかったものを使う):'
  foreach ($c in $cands) {
    $mark = if (Test-Path $c.Path) { '[あり]' } else { '[なし]' }
    Write-Host ("    {0} {1}" -f $mark, $c.Path)
    Write-Host ("           {0}" -f $c.Why)
  }
  Write-Host ''
  Write-Host "  => 使う場所: $chosen"
  Write-Host "     根拠    : $chosenWhy"
  Write-Host ''
  Write-Host '  この場所で合っていれば、-ShowPaths を外して実行してください。'
  Write-Host '  違っていれば -ExtensionsDir "正しいパス" を付けてください。'
  Write-Host ''
  exit 0
}

$dst = Join-Path $chosen $name

Write-Step "環境フォルダ : $PSScriptRoot"
Write-Step "拡張機能の元 : $src"
Write-Step "入れ先       : $dst"
Write-Step "入れ先の根拠 : $chosenWhy"
Write-Host ''

# ---- 既存を取り除く -------------------------------------------------------
if (Test-Path $dst) {
  # ジャンクションの場合、Remove-Item -Recurse はリンクだけを消す (元は残る)
  Remove-Item $dst -Force -Recurse -Confirm:$false
  Write-Step '既存のインストールを取り除いた'
}

if ($Uninstall) {
  # 取り違えて別の場所に入れていた場合に備え、他の候補も掃除する
  foreach ($c in $cands) {
    $other = Join-Path $c.Path $name
    if ((Test-Path $other) -and ($other -ne $dst)) {
      Remove-Item $other -Force -Recurse -Confirm:$false
      Write-Step "別の場所からも取り除いた: $other"
    }
  }
  Write-Host ''
  Write-Host 'アンインストールしました。VS Code を再起動してください。'
  Write-Host ''
  exit 0
}

# ---- 前提を確認 -----------------------------------------------------------
if (-not (Test-Path (Join-Path $src 'package.json'))) {
  Write-Error "拡張機能のソースが見つかりません: $src`nこのスクリプトは環境フォルダの直下に置いたまま実行してください。"
}

if (-not (Test-Path $chosen)) {
  New-Item -ItemType Directory -Path $chosen -Force | Out-Null
  Write-Step "拡張機能フォルダを作成: $chosen"
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
    Write-Step 'それでも認識しない場合は -ShowPaths で入れ先を確認してください'
  }
}

Write-Host ''
Write-Host '完了。次にやること:'
Write-Host ''
Write-Host '  1. VS Code を全ウィンドウ閉じて、起動し直す'
Write-Host '  2. このフォルダをワークスペースとして開く:'
Write-Host "         code `"$PSScriptRoot`""
Write-Host '  3. Ctrl+Alt+D  今日のデイリーノート'
Write-Host '     Ctrl+Alt+T  TaskChute パネル'
Write-Host ''
