# vs-dte.ps1 - Visual Studio DTE bridge for the dsh-vs-assist DSH plugin.
# PURE ASCII ONLY (Windows PowerShell 5.1 reads this file as ANSI).
#
# Invoked by the plugin host as:
#   powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -EncodedCommand "..."
# where the encoded command dot-invokes this file with:
#   -Action <action>  -PayloadFile <path to UTF-8 JSON payload>
#
# Every action prints exactly one JSON line to stdout and exits 0 on success,
# or prints {"ok":false,"error":"..."} and exits 1 on failure.
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Payload = "{}",
  [string]$PayloadFile = ""
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Out-JsonLine($obj) {
  Write-Output ($obj | ConvertTo-Json -Depth 24 -Compress)
}
function Fail([string]$msg) {
  Out-JsonLine @{ ok = $false; error = $msg }
  exit 1
}

$script:dte = $null
$script:progId = ""

function Attach-Dte {
  $script:dte = $null
  $script:progId = ""
  foreach ($p in @("VisualStudio.DTE.18.0", "VisualStudio.DTE.17.0", "VisualStudio.DTE.16.0", "VisualStudio.DTE.15.0")) {
    try {
      $d = [Runtime.InteropServices.Marshal]::GetActiveObject($p)
      if ($d) { $script:dte = $d; $script:progId = $p; return $true }
    } catch {}
  }
  return $false
}

function Get-DocText($textDoc) {
  $start = $textDoc.StartPoint.CreateEditPoint()
  return $start.GetText($textDoc.EndPoint.CreateEditPoint())
}

function Find-DocumentByPath([string]$path) {
  try { $full = [System.IO.Path]::GetFullPath($path) } catch { $full = $path }
  foreach ($d in $script:dte.Documents) {
    try {
      if ($d.FullName -eq $full) { return $d }
    } catch {}
  }
  return $null
}

# Resolve a document by payload path / name / active. Opens it when missing.
# Returns @{ doc = ...; textDoc = ... } or $null.
function Resolve-Document($p) {
  $doc = $null
  if ($p.path) {
    $doc = Find-DocumentByPath $p.path
    if (-not $doc) {
      for ($i = 0; $i -lt 10 -and -not $doc; $i++) {
        try {
          $w = $script:dte.ItemOperations.OpenFile($p.path)
          Start-Sleep -Milliseconds 300
          $doc = $w.Document
          if (-not $doc) { $doc = Find-DocumentByPath $p.path }
        } catch { Start-Sleep -Milliseconds 400 }
      }
    }
  } elseif ($p.name) {
    try { $doc = $script:dte.Documents.Item($p.name) } catch {}
  } else {
    $doc = $script:dte.ActiveDocument
  }
  if (-not $doc) { return $null }
  try { $doc.Activate() } catch {}
  try {
    $textDoc = $doc.Object("TextDocument")
    return @{ doc = $doc; textDoc = $textDoc }
  } catch {
    return $null
  }
}

function Get-CaretInfo($sel) {
  $off = $sel.ActivePoint.CreateEditPoint().AbsoluteCharOffset
  return @{
    line = $sel.ActivePoint.Line
    column = $sel.ActivePoint.DisplayColumn
    offset = $off
  }
}

function Get-SuppressedUi {
  try { return [bool]$script:dte.SuppressUI } catch { return $false }
}

$p = $null
if ($PayloadFile) {
  try {
    $raw = Get-Content -LiteralPath $PayloadFile -Raw -Encoding UTF8
    $p = $raw | ConvertFrom-Json
  } catch {
    Fail ("payload read failed: " + $_.Exception.Message)
  }
} else {
  try { $p = $Payload | ConvertFrom-Json } catch { Fail ("payload parse failed: " + $_.Exception.Message) }
}

switch ($Action) {
  "status" {
    if (-not (Attach-Dte)) { Fail "no running Visual Studio instance found" }
    $ad = $script:dte.ActiveDocument
    $adInfo = $null
    if ($ad) {
      $adInfo = @{
        name = $ad.Name
        fullName = $ad.FullName
        language = $ad.Language
        saved = $ad.Saved
      }
    }
    $caption = ""
    try { $caption = [string]$script:dte.MainWindow.Caption } catch {}
    $solution = ""
    try { $solution = [string]$script:dte.Solution.FullName } catch {}
    Out-JsonLine @{
      ok = $true
      progId = $script:progId
      name = $script:dte.Name
      version = $script:dte.Version
      fullName = $script:dte.FullName
      solution = $solution
      mode = $script:dte.Mode
      suppressedUi = (Get-SuppressedUi)
      caption = $caption
      activeDocument = $adInfo
    }
  }

  "document" {
    if (-not (Attach-Dte)) { Fail "no running Visual Studio instance found" }
    $r = Resolve-Document $p
    if (-not $r) { Fail "document not found" }
    $doc = $r.doc
    $textDoc = $r.textDoc
    $text = Get-DocText $textDoc
    $sel = $textDoc.Selection
    $anchor = $sel.AnchorPoint
    $active = $sel.ActivePoint
    $anchorOff = $anchor.CreateEditPoint().AbsoluteCharOffset
    $activeOff = $active.CreateEditPoint().AbsoluteCharOffset
    $selStart = [Math]::Min([int]$anchorOff, [int]$activeOff)
    $selEnd = [Math]::Max([int]$anchorOff, [int]$activeOff)
    Out-JsonLine @{
      ok = $true
      name = $doc.Name
      fullName = $doc.FullName
      language = $doc.Language
      saved = $doc.Saved
      totalLines = $textDoc.EndPoint.Line
      text = $text
      caret = @{
        line = $active.Line
        column = $active.DisplayColumn
        offset = $activeOff
      }
      selection = @{
        hasSelection = (-not $sel.IsEmpty)
        text = $sel.Text
        startOffset = $selStart
        endOffset = $selEnd
        startLine = $sel.TopPoint.Line
        endLine = $sel.BottomPoint.Line
      }
    }
  }

  "edit" {
    if (-not (Attach-Dte)) { Fail "no running Visual Studio instance found" }
    $r = Resolve-Document $p
    if (-not $r) { Fail "document not found" }
    $doc = $r.doc
    $textDoc = $r.textDoc
    $sel = $textDoc.Selection
    $text = $p.text
    if ($null -eq $text) { Fail "text is required" }
    # detect line-ending state before editing: mixed endings make Visual Studio
    # raise a modal prompt that blocks all further DTE automation
    $lineEnding = ""
    $lineEndingWarning = ""
    try {
      $preText = Get-DocText $textDoc
      $hasCrlf = $preText.Contains("`r`n")
      $hasLfOnly = [regex]::IsMatch($preText, "(?<![`r])`n")
      if ($hasCrlf -and $hasLfOnly) {
        $lineEnding = "MIXED"
        $lineEndingWarning = "document has mixed line endings; Visual Studio may show a modal prompt that blocks automation until the user confirms - consider normalizing line endings first"
      } elseif ($hasCrlf) {
        $lineEnding = "CRLF"
      } elseif ($hasLfOnly) {
        $lineEnding = "LF"
      }
    } catch {}
    $mode = $p.mode
    if (-not $mode) { $mode = "insert" }
    switch ($mode) {
      "insert" {
        # inserts at the caret; replaces the selection when one exists
        $sel.Insert($text)
      }
      "replace_selection" {
        if ($sel.IsEmpty) { Fail "no selection to replace" }
        $sel.Insert($text)
      }
      "replace_range" {
        if ($null -eq $p.startOffset -or $null -eq $p.endOffset) { Fail "startOffset and endOffset are required for replace_range" }
        $startOff = [int]$p.startOffset
        $endOff = [int]$p.endOffset
        $total = $textDoc.EndPoint.CreateEditPoint().AbsoluteCharOffset
        if ($startOff -lt 1 -or $endOff -gt $total -or $startOff -gt $endOff) { Fail "offsets out of range" }
        $epStart = $textDoc.StartPoint.CreateEditPoint()
        $epEnd = $textDoc.StartPoint.CreateEditPoint()
        $epStart.MoveToAbsoluteOffset($startOff)
        $epEnd.MoveToAbsoluteOffset($endOff)
        $epStart.ReplaceText($epEnd, $text, 0)
      }
      "replace_document" {
        $sel.SelectAll()
        $sel.Insert($text)
      }
      default { Fail "unknown edit mode: $mode" }
    }
    if ($p.format) {
      try { $script:dte.ExecuteCommand("Edit.FormatDocument") } catch {}
    }
    $sel2 = $textDoc.Selection
    $caretOff = $sel2.ActivePoint.CreateEditPoint().AbsoluteCharOffset
    Out-JsonLine @{
      ok = $true
      mode = $mode
      file = $doc.FullName
      caretLine = $sel2.ActivePoint.Line
      caretColumn = $sel2.ActivePoint.DisplayColumn
      caretOffset = $caretOff
      totalLines = $textDoc.EndPoint.Line
      lineEnding = $lineEnding
      lineEndingWarning = $lineEndingWarning
    }
  }

  "select" {
    if (-not (Attach-Dte)) { Fail "no running Visual Studio instance found" }
    $r = Resolve-Document $p
    if (-not $r) { Fail "document not found" }
    $sel = $r.textDoc.Selection
    if ($null -ne $p.startOffset -and $null -ne $p.endOffset) {
      $sel.MoveToAbsoluteOffset([int]$p.startOffset, $false)
      $sel.MoveToAbsoluteOffset([int]$p.endOffset, $true)
    } elseif ($null -ne $p.offset) {
      $sel.MoveToAbsoluteOffset([int]$p.offset, $false)
    } elseif ($null -ne $p.line) {
      $sel.GotoLine([int]$p.line, $false)
      if ($null -ne $p.column) {
        $sel.MoveToLineAndOffset([int]$p.line, [int]$p.column, $false)
      }
    }
    Out-JsonLine @{
      ok = $true
      caret = (Get-CaretInfo $sel)
      selection = @{ hasSelection = (-not $sel.IsEmpty); text = $sel.Text }
    }
  }

  "open" {
    if (-not (Attach-Dte)) { Fail "no running Visual Studio instance found" }
    # solution files open through the solution interface instead of the editor
    $isSolution = $false
    if ($p.path) {
      $lower = $p.path.ToLower()
      if ($lower.EndsWith(".sln") -or $lower.EndsWith(".slnx")) { $isSolution = $true }
    }
    if ($isSolution) {
      if (-not (Test-Path -LiteralPath $p.path)) { Fail ("solution file not found: " + $p.path) }
      try {
        $script:dte.Solution.Open($p.path)
      } catch {
        Fail ("Solution.Open failed: " + $_.Exception.Message)
      }
      $openedName = ""
      try { $openedName = [string]$script:dte.Solution.FullName } catch {}
      Out-JsonLine @{ ok = $true; solution = $openedName }
    } else {
      $r = Resolve-Document $p
      if (-not $r) { Fail ("could not open document: " + $p.path) }
      $sel = $r.textDoc.Selection
      if ($null -ne $p.line) {
        $sel.GotoLine([int]$p.line, $false)
        if ($null -ne $p.column) {
          $sel.MoveToLineAndOffset([int]$p.line, [int]$p.column, $false)
        }
      }
      $doc = $r.doc
      Out-JsonLine @{
        ok = $true
        name = $doc.Name
        fullName = $doc.FullName
        language = $doc.Language
        totalLines = $r.textDoc.EndPoint.Line
        caret = (Get-CaretInfo $sel)
      }
    }
  }

  "save" {
    if (-not (Attach-Dte)) { Fail "no running Visual Studio instance found" }
    if ($p.all) {
      $script:dte.ExecuteCommand("File.SaveAll")
      Out-JsonLine @{ ok = $true; savedAll = $true }
    } else {
      $r = Resolve-Document $p
      if (-not $r) { Fail "document not found" }
      $r.doc.Save()
      Out-JsonLine @{ ok = $true; file = $r.doc.FullName }
    }
  }

  "build_ide" {
    if (-not (Attach-Dte)) { Fail "no running Visual Studio instance found" }
    if (-not $script:dte.Solution.FullName) { Fail "no solution is open" }
    $sb = $script:dte.Solution.SolutionBuild
    $sb.Build($true)
    $errs = @()
    $listOk = $false
    try {
      $items = $script:dte.ToolWindows.ErrorList.ErrorItems
      $listOk = $true
      $max = 100
      if ($items.Count -lt $max) { $max = $items.Count }
      for ($i = 1; $i -le $max; $i++) {
        $it = $items.Item($i)
        $errs += @{
          description = $it.Description
          file = $it.FileName
          line = $it.Line
          column = $it.Column
          level = $it.ErrorLevel
        }
      }
    } catch { $listOk = $false }
    $info = $sb.LastBuildInfo
    Out-JsonLine @{
      ok = $true
      succeeded = ($info -eq 0)
      lastBuildInfo = $info
      buildState = $sb.BuildState
      errorListAvailable = $listOk
      errors = $errs
    }
  }

  "errors" {
    if (-not (Attach-Dte)) { Fail "no running Visual Studio instance found" }
    $limit = 100
    if ($null -ne $p.limit) { $limit = [int]$p.limit }
    $errs = @()
    $listOk = $false
    try {
      $items = $script:dte.ToolWindows.ErrorList.ErrorItems
      $listOk = $true
      $max = $limit
      if ($items.Count -lt $max) { $max = $items.Count }
      for ($i = 1; $i -le $max; $i++) {
        $it = $items.Item($i)
        $errs += @{
          description = $it.Description
          file = $it.FileName
          line = $it.Line
          column = $it.Column
          level = $it.ErrorLevel
        }
      }
    } catch { $listOk = $false }
    Out-JsonLine @{ ok = $true; available = $listOk; count = $errs.Count; errors = $errs }
  }

  "solution" {
    if (-not (Attach-Dte)) { Fail "no running Visual Studio instance found" }
    $projs = @()
    $sol = $script:dte.Solution
    $solName = ""
    try { $solName = [string]$sol.FullName } catch {}
    if ($solName) {
      foreach ($pr in $sol.Projects) {
        $projs += @{ name = $pr.Name; uniqueName = $pr.UniqueName; kind = $pr.Kind }
      }
    }
    Out-JsonLine @{
      ok = $true
      fullName = $solName
      projectCount = $projs.Count
      projects = $projs
    }
  }

  "open_solution" {
    if (-not (Attach-Dte)) { Fail "no running Visual Studio instance found" }
    if (-not $p.path) { Fail "path is required" }
    if (-not (Test-Path -LiteralPath $p.path)) { Fail ("solution file not found: " + $p.path) }
    try {
      $script:dte.Solution.Open($p.path)
    } catch {
      Fail ("Solution.Open failed: " + $_.Exception.Message)
    }
    $openedName = ""
    try { $openedName = [string]$script:dte.Solution.FullName } catch {}
    Out-JsonLine @{ ok = $true; solution = $openedName }
  }

  "run" {
    if (-not (Attach-Dte)) { Fail "no running Visual Studio instance found" }
    $cmd = ""
    switch ($p.action) {
      "start" { $cmd = "Debug.Start" }
      "start_without_debug" { $cmd = "Debug.StartWithoutDebugging" }
      "stop" { $cmd = "Debug.StopDebugging" }
      default { Fail "unknown run action: $($p.action)" }
    }
    $note = ""
    try {
      $script:dte.ExecuteCommand($cmd)
    } catch {
      $note = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 600
    Out-JsonLine @{ ok = $true; command = $cmd; mode = $script:dte.Mode; note = $note }
  }

  "exec_command" {
    if (-not (Attach-Dte)) { Fail "no running Visual Studio instance found" }
    $allowed = @(
      "Edit.FormatDocument", "Edit.FormatSelection",
      "Edit.CommentSelection", "Edit.UncommentSelection",
      "Edit.Undo", "Edit.Redo",
      "Edit.GoToDefinition", "Edit.GoToDeclaration", "Edit.FindAllReferences",
      "Edit.SelectAll", "Edit.Copy", "Edit.Cut", "Edit.Paste",
      "Edit.ToggleBookmark", "Edit.NextBookmark", "Edit.PreviousBookmark",
      "Edit.ExpandAllOutlining", "Edit.CollapseAllOutlining",
      "View.ErrorList", "View.Output", "View.SolutionExplorer",
      "File.SaveAll", "File.Close"
    )
    if (-not $p.name -or ($allowed -notcontains $p.name)) {
      Fail ("command not allowed: " + $p.name)
    }
    try {
      $script:dte.ExecuteCommand($p.name)
      Out-JsonLine @{ ok = $true; command = $p.name }
    } catch {
      Fail ("execute failed: " + $_.Exception.Message)
    }
  }

  default {
    Fail ("unknown action: " + $Action)
  }
}
