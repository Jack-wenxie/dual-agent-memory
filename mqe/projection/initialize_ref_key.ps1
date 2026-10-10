param(
    [Parameter(Mandatory=$true)][string]$KeyPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$projectRoot = Split-Path -Parent $PSScriptRoot
$KeyPath = [IO.Path]::GetFullPath($KeyPath)
$parent = Split-Path -Parent $KeyPath
New-Item -ItemType Directory -Path $parent -Force | Out-Null

$entropy = [Text.Encoding]::UTF8.GetBytes('mqe-ref-key/v1')
if (Test-Path -LiteralPath $KeyPath) {
    $blob = [IO.File]::ReadAllBytes($KeyPath)
    $key = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $blob,
        $entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    if ($key.Length -ne 32) { throw 'invalid existing MQE ref key length' }
} else {
    $key = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($key) } finally { $rng.Dispose() }
    $blob = [System.Security.Cryptography.ProtectedData]::Protect(
        $key,
        $entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [IO.File]::WriteAllBytes($KeyPath, $blob)
}

$hmac = [System.Security.Cryptography.HMACSHA256]::new($key)
try {
    $idBytes = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes('mqe-ref-key-id/v1'))
    $keyId = 'rk1_' + (($idBytes | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 32)
} finally {
    $hmac.Dispose()
    [Array]::Clear($key, 0, $key.Length)
}

Write-Output (ConvertTo-Json ([ordered]@{
    status = 'ready'
    key_path = $KeyPath
    ref_key_id = $keyId
}))
