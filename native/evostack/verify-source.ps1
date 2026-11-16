param([Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedRevision)
$ErrorActionPreference = 'Stop'
$EvoRepo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$EvoRevision = & git -C $EvoRepo rev-parse --verify HEAD
if ($LASTEXITCODE -ne 0) { throw 'Could not identify source revision' }
if ($EvoRevision -cne $ExpectedRevision) { throw 'Source revision does not match ExpectedRevision' }
$EvoChanges = & git -C $EvoRepo status --porcelain=v1 --untracked-files=all
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect source worktree' }
if ($EvoChanges) { throw 'Expected a clean source worktree, including untracked files' }
