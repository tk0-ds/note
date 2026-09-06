<#
  TaskChute for VS Code をこの PC にインストールする。

  使い方:
      powershell -ExecutionPolicy Bypass -File ./install.ps1

  オプション:
      -ShowPaths       どこに入れるかだけ調べて表示する (インストールしない)
      -Copy            ジャンクション (フォルダの別名) ではなく、実体コピーで入れる
      -Uninstall       入れたものを取り除く
      -ExtensionsDir   VS Code の拡張機能フォルダを明示する (省略時は自動判別)

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
  そのフォルダが「VS Code が実際に使っている拡張機能フォルダ」かを判定する。

  VS Code は拡張機能フォルダに extensions.json (導入済み一覧) と
  .obsolete を置く。これが決定的な目印になる。
  code --list-extensions は ID を並べるだけで場所を教えてくれないため、
  ファイルの痕跡から見つけるのが確実。
#>
function Test-ExtensionsDir($path) {
  if (-not $path) { return $false }
  if (-not (Test-Path $path)) { return $false }
  if (Test-Path (Join-Path $path 'extensions.json')) { return $true }
  if (Test-Path (Join-Path $path '.obsolete')) { return $true }
  # publisher.name-version という形のフォルダがあれば拡張機能フォルダとみなす
  $like = Get-ChildItem -Path $path -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^[^.]+\.[^.]+.*-\d' } | Select-Object -First 1
  return [bool]$like
}

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

<# 探す順に候補を並べる #>
function Get-Candidates {
  $c = @()

  if ($env:VSCODE_EXTENSIONS) {
    $c += ,@{ Path = $env:VSCODE_EXTENSIONS; Why = '環境変数 VSCODE_EXTENSIONS' }
  }
  if ($env:VSCODE_PORTABLE) {
    $c += ,@{ Path = (Join-Path $env:VSCODE_PORTABLE 'extensions'); Why = '環境変数 VSCODE_PORTABLE' }
  }

  # Scoop に本体の場所を聞く (一番確か)。
  # vscode を scoop で入れていない環境ではエラー文が返るので、
  # 実在するパスが返ってきたときだけ候補にする。
  if (Get-Command scoop -ErrorAction SilentlyContinue) {
    try {
      $out = & scoop prefix vscode *>&1
      $line = $out | Where-Object { $_ -is [string] -and (Test-Path $_.Trim()) } | Select-Object -First 1
      if ($line) {
        $c += ,@{ Path = (Join-Path $line.Trim() 'data\extensions'); Why = 'scoop prefix vscode' }
      }
    } catch { }
  }

  $root = Resolve-CodeRoot
  if ($root) {
    $c += ,@{ Path = (Join-Path $root 'data\extensions'); Why = "ポータブル構成 ($root)" }
  }

  $c += ,@{ Path = (Join-Path $env:USERPROFILE 'scoop\persist\vscode\data\extensions'); Why = 'Scoop の persist フォルダ' }
  $c += ,@{ Path = (Join-Path $env:USERPROFILE 'scoop\apps\vscode\current\data\extensions'); Why = 'Scoop の apps フォルダ' }
  $c += ,@{ Path = (Join-Path $env:USERPROFILE '.vscode\extensions'); Why = '標準の場所' }
  return $c
}

<#
  候補が全部外れたときの最後の手段。
  extensions.json を手掛かりに、範囲を絞って探す。
#>
function Find-ByMarker {
  $roots = @(
    (Join-Path $env:USERPROFILE 'scoop\persist'),
    (Join-Path $env:USERPROFILE 'scoop\apps'),
    (Resolve-CodeRoot),
    (Join-Path $env:USERPROFILE '.vscode-insiders'),
    (Join-Path $env:APPDATA 'Code')
  ) | Where-Object { $_ -and (Test-Path $_) }

  foreach ($r in $roots) {
    $hit = Get-ChildItem -Path $r -Filter 'extensions.json' -Recurse -Depth 5 -File -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($hit) { return $hit.DirectoryName }
  }
  return $null
}

<#
  VS Code のバージョンが package.json の engines を満たすか調べる。
  古すぎると VS Code は拡張機能を黙って読み込まないので、
  「入れたのに command not found」の原因になる。
#>
function Test-CodeVersion {
  $result = @{ Installed = $null; Required = $null; Ok = $true; Known = $false }

  $pkgPath = Join-Path $src 'package.json'
  if (Test-Path $pkgPath) {
    $raw = Get-Content $pkgPath -Raw
    if ($raw -match '"vscode"\s*:\s*"\^?([0-9]+)\.([0-9]+)\.([0-9]+)"') {
      $result.Required = "$($Matches[1]).$($Matches[2]).$($Matches[3])"
      $reqMajor = [int]$Matches[1]; $reqMinor = [int]$Matches[2]
    }
  }

  $cmd = Get-Command code -ErrorAction SilentlyContinue
  if ($cmd -and $result.Required) {
    $v = & $cmd.Source --version 2>$null | Select-Object -First 1
    if ($v -and $v -match '^([0-9]+)\.([0-9]+)\.([0-9]+)') {
      $result.Installed = $v.Trim()
      $result.Known = $true
      $curMajor = [int]$Matches[1]; $curMinor = [int]$Matches[2]
      $result.Ok = ($curMajor -gt $reqMajor) -or (($curMajor -eq $reqMajor) -and ($curMinor -ge $reqMinor))
    }
  }
  return $result
}

<# 他の候補フォルダに入れ残しがないか #>
function Find-StaleInstalls($cands, $keep) {
  $stale = @()
  foreach ($c in $cands) {
    $other = Join-Path $c.Path $name
    if ((Test-Path $other) -and ($other -ne $keep)) { $stale += $other }
  }
  return $stale
}

Write-Host ''
Write-Host 'TaskChute for VS Code'
Write-Host ('=' * 62)

# ---- 入れ先を決める -------------------------------------------------------
$cands = Get-Candidates
$chosen = $null
$chosenWhy = ''

if ($ExtensionsDir) {
  $chosen = $ExtensionsDir
  $chosenWhy = '-ExtensionsDir で指定'
} else {
  # 1) VS Code が実際に使っている形跡があるものを最優先
  foreach ($c in $cands) {
    if (Test-ExtensionsDir $c.Path) { $chosen = $c.Path; $chosenWhy = $c.Why + ' / 使用中の形跡あり'; break }
  }
  # 2) 形跡は無いが存在はするもの
  if (-not $chosen) {
    foreach ($c in $cands) {
      if (Test-Path $c.Path) { $chosen = $c.Path; $chosenWhy = $c.Why + ' / フォルダは存在'; break }
    }
  }
  # 3) 範囲を絞って探す
  if (-not $chosen) {
    $found = Find-ByMarker
    if ($found) { $chosen = $found; $chosenWhy = 'extensions.json を探して発見' }
  }
  # 4) それでも駄目なら標準の場所に作る
  if (-not $chosen) {
    $last = $cands[$cands.Count - 1]
    $chosen = $last.Path
    $chosenWhy = $last.Why + ' / 手掛かりが無いので既定'
  }
}

$dstPreview = Join-Path $chosen $name

if ($ShowPaths) {
  Write-Host ''
  $cmd = Get-Command code -ErrorAction SilentlyContinue
  if ($cmd) { Write-Step "code コマンド: $($cmd.Source)" } else { Write-Step 'code コマンド: 見つかりません (PATH に無い)' }
  $root = Resolve-CodeRoot
  if ($root) { Write-Step "本体フォルダ : $root" }

  $ver = Test-CodeVersion
  if ($ver.Known) {
    if ($ver.Ok) {
      Write-Step "VS Code     : $($ver.Installed)  (必要 $($ver.Required) 以上 / OK)"
    } else {
      Write-Step "VS Code     : $($ver.Installed)  ★必要 $($ver.Required) 以上"
      Write-Step '              古すぎるため、VS Code は拡張機能を読み込みません。'
      Write-Step '              これが command not found の原因です。VS Code を更新してください。'
    }
  } else {
    Write-Step 'VS Code     : バージョンを確認できませんでした'
  }
  Write-Host ''
  Write-Host '  拡張機能フォルダの候補:'
  Write-Host '    [使用中] = extensions.json などがあり、VS Code が実際に使っている'
  Write-Host ''
  foreach ($c in $cands) {
    $mark = if (Test-ExtensionsDir $c.Path) { '[使用中]' } elseif (Test-Path $c.Path) { '[空あり]' } else { '[  なし]' }
    Write-Host ("    {0} {1}" -f $mark, $c.Path)
    Write-Host ("             {0}" -f $c.Why)
  }
  Write-Host ''
  Write-Host "  => 使う場所: $chosen"
  Write-Host "     根拠    : $chosenWhy"
  if (Test-ExtensionsDir $chosen) {
    $n = (Get-ChildItem -Path $chosen -Directory -ErrorAction SilentlyContinue).Count
    Write-Host "     この場所に入っている拡張機能: $n 個"
  } else {
    Write-Host '     ★ 使用中の形跡がありません。場所が違う可能性があります。'
    Write-Host '       VS Code の「拡張機能」画面で何か入っているのに 0 個なら、'
    Write-Host '       -ExtensionsDir で正しいパスを指定してください。'
  }

  $stale = Find-StaleInstalls $cands $dstPreview
  if ($stale.Count -gt 0) {
    Write-Host ''
    Write-Host '  別の場所に入れ残しがあります (-Uninstall で掃除できます):'
    foreach ($x in $stale) { Write-Host "    $x" }
  }

  $installed = Join-Path $chosen $name
  Write-Host ''
  if (Test-Path $installed) {
    Write-Host "  この場所には既にインストール済み: $installed"
  } else {
    Write-Host '  この場所にはまだ入っていません。-ShowPaths を外して実行してください。'
  }
  Write-Host ''
  exit 0
}

$dst = Join-Path $chosen $name

Write-Step "環境フォルダ : $PSScriptRoot"
Write-Step "拡張機能の元 : $src"
Write-Step "入れ先       : $dst"
Write-Step "入れ先の根拠 : $chosenWhy"
if (-not $ExtensionsDir -and -not (Test-ExtensionsDir $chosen)) {
  Write-Step '注意: この場所に VS Code の使用中の形跡がありません。'
  Write-Step '      入れても認識されない場合は -ShowPaths で確認してください。'
}
$ver = Test-CodeVersion
if ($ver.Known -and -not $ver.Ok) {
  Write-Step "★注意: VS Code $($ver.Installed) は古すぎます (必要 $($ver.Required) 以上)。"
  Write-Step '        このままでは読み込まれません。VS Code を更新してください。'
}
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
    Write-Step '再起動しても駄目なら -ShowPaths で入れ先を確認してください'
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
