param(
    [ValidateSet('rebuild', 'incremental', 'verify', 'repair')]
    [string]$Mode = 'verify',
    [string]$DataDir = '',
    [string]$KeyPath = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$env:MQE_ROOT = $projectRoot
$env:MQE_MODE = $Mode
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
if ($DataDir) {
    $env:MQE_DATA_DIR = (Resolve-Path -LiteralPath $DataDir).Path
} else {
    Remove-Item Env:MQE_DATA_DIR -ErrorAction SilentlyContinue
}
if ($KeyPath) {
    $env:MQE_REF_KEY_PATH = [IO.Path]::GetFullPath($KeyPath)
} else {
    Remove-Item Env:MQE_REF_KEY_PATH -ErrorAction SilentlyContinue
}

$python = if ($env:MQE_PYTHON) { $env:MQE_PYTHON } else { (Get-Command python.exe -ErrorAction Stop).Source }
$defaultManagedNodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$nodeExeCandidate = if ([string]::IsNullOrWhiteSpace($env:AI_NODE_EXE)) { $defaultManagedNodeExe } else { $env:AI_NODE_EXE }
if (-not (Test-Path -LiteralPath $nodeExeCandidate -PathType Leaf)) {
    throw "Managed Node executable missing: $nodeExeCandidate"
}
$nodeExe = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $nodeExeCandidate).Path)
$outputDir = Join-Path $projectRoot 'runs\projection'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$priorErrorActionPreference = $ErrorActionPreference
try {
    # nbconvert writes its normal conversion notice to stderr even when it exits 0.
    $ErrorActionPreference = 'Continue'
    & $python -m jupyter nbconvert --to notebook --execute --ExecutePreprocessor.timeout=900 --output 'build_projection.executed.ipynb' --output-dir $outputDir (Join-Path $PSScriptRoot 'build_projection.ipynb')
    $nbconvertExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $priorErrorActionPreference
}
if ($nbconvertExitCode -ne 0) { exit $nbconvertExitCode }
if ($Mode -eq 'verify') {
    $priorErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $nodeExe (Join-Path $PSScriptRoot 'audit_projection.mjs')
        $auditExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $priorErrorActionPreference
    }
    if ($auditExitCode -ne 0) { exit $auditExitCode }
}
