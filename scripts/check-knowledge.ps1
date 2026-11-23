[CmdletBinding()]
param(
    [string]$PluginRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'unreal\DSHUnrealBridge'),
    [switch]$RunTests
)
$ErrorActionPreference = 'Stop'
$PluginRoot = (Resolve-Path -LiteralPath $PluginRoot).Path
$required = @(
    'Runtime/Win64/node.exe',
    'Tools/knowledge-worker.mjs',
    'Tools/knowledge-tools.mjs',
    'Tools/experience-store.mjs',
    'Tools/ProjectGraph/dist/src/commands/buildGraph.js',
    'Tools/ProjectMemorySystem/dist/src/commands/buildMemory.js',
    'Tools/ProjectMemorySystem/dist/src/sources/protoParser.js',
    'Tools/ProjectMemorySystem/dist/src/sources/xlsParser.js',
    'Config/Knowledge/ProjectMemory.project.json',
    'ThirdParty/Node/LICENSE'
)
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $PluginRoot $_) -PathType Leaf) })
if ($missing.Count -gt 0) {
    throw "Incomplete knowledge runtime in ${PluginRoot}: $($missing -join ', '). Run scripts/prepare-knowledge.ps1 and copy Runtime and Tools to the project plugin."
}
$nodePath = Join-Path $PluginRoot 'Runtime/Win64/node.exe'
$expectedHash = '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5'
if ((Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'Bundled Node runtime does not match the pinned Node.js 24.15.0 release.'
}
$version = & $nodePath --version
if ($LASTEXITCODE -ne 0 -or $version -ne 'v24.15.0') {
    throw "Bundled Node runtime could not report v24.15.0: $version"
}
# Importing the worker validates its transitive dist dependencies without starting
# a request, creating project caches, or connecting to the editor. The file URL keeps
# the module in import mode, so the check does not depend on the current directory and
# never starts the JSONL CLI entry point.
$workerPath = Join-Path $PluginRoot 'Tools/knowledge-worker.mjs'
$workerUrl = ([uri](Resolve-Path -LiteralPath $workerPath).Path).AbsoluteUri
& $nodePath --input-type=module -e "await import(process.argv[1]);" $workerUrl
if ($LASTEXITCODE -ne 0) { throw 'Knowledge worker dependency validation failed.' }
if ($RunTests) {
    & $nodePath (Join-Path $PluginRoot 'Tools/test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Knowledge tool tests failed.' }
}
Write-Output "Verified knowledge runtime: $PluginRoot ($version)"
