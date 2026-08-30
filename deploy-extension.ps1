# Deploys the Adventure Choice Buttons UI extension into SillyTavern's public extensions folder.
# Run from the SillyTavern root or anywhere; the script detects its own location.
# Set SILLYTAVERN_ROOT environment variable to override the auto-detected root.
# Set DEPLOY_TARGET environment variable to copy directly to a specific host path (useful for Docker).
$ErrorActionPreference = 'Stop'

$pluginsRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$source = $PSScriptRoot
$files = @('index.js', 'manifest.json', 'style.css')

foreach ($file in $files) {
    if (-not (Test-Path (Join-Path $source $file))) {
        Write-Error "Extension source file not found: $(Join-Path $source $file)"
    }
}

if ($env:DEPLOY_TARGET) {
    $destination = $env:DEPLOY_TARGET
} else {
    # Discover the SillyTavern root directory (the one containing public\scripts\extensions).
    function Find-SillyTavernRoot {
        param([string]$PluginsRoot)

        $candidates = @()
        if ($env:SILLYTAVERN_ROOT) {
            $candidates += (Resolve-Path $env:SILLYTAVERN_ROOT -ErrorAction SilentlyContinue)
        }
        $candidates += $PluginsRoot
        $candidates += (Join-Path $PluginsRoot 'sillytavern')

        foreach ($candidate in $candidates) {
            if (-not $candidate) { continue }
            if (Test-Path (Join-Path $candidate 'public\scripts\extensions')) {
                return $candidate
            }
        }
        return $null
    }

    $stRoot = Find-SillyTavernRoot -PluginsRoot $pluginsRoot
    if (-not $stRoot) {
        Write-Error "SillyTavern public extensions folder not found.`nTried: $pluginsRoot\public\scripts\extensions`nTried: $pluginsRoot\sillytavern\public\scripts\extensions`nSet SILLYTAVERN_ROOT environment variable to point to the directory containing public\`nOr set DEPLOY_TARGET environment variable to the full host path of the extension directory (useful for Docker)"
    }

    $destination = Join-Path $stRoot 'public\scripts\extensions\adventure-choice-buttons'
}

$parent = Split-Path -Parent $destination
if (-not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
}

if (Test-Path $destination) {
    Remove-Item -Path $destination -Recurse -Force
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null

foreach ($file in $files) {
    Copy-Item -Path (Join-Path $source $file) -Destination (Join-Path $destination $file) -Force
}
Write-Output "Adventure Choice Buttons UI extension deployed to: $destination"
