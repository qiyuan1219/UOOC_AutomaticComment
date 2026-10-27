$ErrorActionPreference = 'Stop'
$taskProject = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskOutput = Join-Path $taskProject 'dist'
$taskManifest = Get-Content -LiteralPath (Join-Path $taskProject 'extension/manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskVersion = $taskManifest.version
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null

function Get-PackagePaths([string[]] $relativePaths) {
    foreach ($relativePath in $relativePaths) {
        $resolvedPath = [System.IO.Path]::GetFullPath((Join-Path $taskProject $relativePath))
        if (-not $resolvedPath.StartsWith($taskProject + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Package input is outside the project: $relativePath"
        }
        if (-not (Test-Path -LiteralPath $resolvedPath)) { throw "Missing package input: $relativePath" }
        $resolvedPath
    }
}

$taskBaseFiles = @('extension', 'docs', 'README.md', 'CHANGELOG.md', '安装说明.txt')
$taskSourceFiles = $taskBaseFiles + @('demo', 'tests', 'scripts', 'package.json', 'package-lock.json', '.gitignore', '.gitattributes')
$taskInstallZip = Join-Path $taskOutput "szu-uooc-discussion-helper-v$taskVersion.zip"
$taskSourceZip = Join-Path $taskOutput "szu-uooc-discussion-helper-v$taskVersion-source.zip"
Compress-Archive -LiteralPath @(Get-PackagePaths $taskBaseFiles) -DestinationPath $taskInstallZip -Force
Compress-Archive -LiteralPath @(Get-PackagePaths $taskSourceFiles) -DestinationPath $taskSourceZip -Force
Write-Output $taskInstallZip
Write-Output $taskSourceZip
