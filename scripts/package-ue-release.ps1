[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PackagedPlugin,
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$EngineLabel
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $PackagedPlugin).Path
$output = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../dist/ue'))
$required = @(
    'DSHUnrealBridge.uplugin', 'Binaries/Win64/UnrealEditor.modules',
    'Binaries/Win64/UnrealEditor-DSHUnrealBridge.dll',
    'Binaries/Win64/UnrealEditor-DSHUnrealBridgeKnowledge.dll',
    'Binaries/Win64/UnrealEditor-DSHUnrealBridgeMCP.dll',
    'Runtime/Win64/node.exe', 'Tools/knowledge-worker.mjs',
    'Tools/knowledge-core.mjs', 'Tools/package.json',
    'Tools/ProjectMemorySystem/dist/src/sources/pdfParser.js',
    'Config/Knowledge/ProjectMemory.project.json', 'ThirdParty/Node/LICENSE'
)
foreach ($name in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $name) -PathType Leaf)) { throw "Missing packaged file: $name" }
}
New-Item -ItemType Directory -Path $output -Force | Out-Null
$stage = Join-Path $output ('.stage-' + [guid]::NewGuid().ToString('N'))
$plugin = Join-Path $stage 'DSHUnrealBridge'
$archive = Join-Path $output ("DSHUnrealBridge-$EngineLabel.zip")
try {
    New-Item -ItemType Directory -Path $plugin -Force | Out-Null
    Get-ChildItem -LiteralPath $source | Where-Object { $_.Name -notin @('HostProject','Intermediate') } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $plugin -Recurse
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $temporaryArchive = Join-Path $stage 'release.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($plugin, $temporaryArchive, [IO.Compression.CompressionLevel]::Optimal, $true)
    Move-Item -LiteralPath $temporaryArchive -Destination $archive -Force
    $digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$archive.sha256", "$digest  $([IO.Path]::GetFileName($archive))`n")
    Write-Output "UE release: $archive"
    Write-Output "SHA256: $digest"
} finally {
    # Only remove the unique staging directory directly inside this output root.
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    if ([IO.Path]::GetDirectoryName($resolvedStage) -ne $output -or [IO.Path]::GetFileName($resolvedStage) -notlike '.stage-*') { throw 'Unsafe staging directory' }
    if (Test-Path -LiteralPath $resolvedStage) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
}
