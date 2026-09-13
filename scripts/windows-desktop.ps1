$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$uiaAvailable = $true
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  $uiaAvailable = $false
}

if (-not ("WebAgentBridge.Native" -as [type])) {
  $references = @(
    [System.Drawing.Bitmap].Assembly.Location,
    [System.Windows.Forms.SendKeys].Assembly.Location
  )
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace WebAgentBridge {
  public static class Native {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    public const uint MOUSE_LEFT_DOWN = 0x0002, MOUSE_LEFT_UP = 0x0004;
    public const uint MOUSE_RIGHT_DOWN = 0x0008, MOUSE_RIGHT_UP = 0x0010;
    public const uint MOUSE_MIDDLE_DOWN = 0x0020, MOUSE_MIDDLE_UP = 0x0040;
    public const uint MOUSE_WHEEL = 0x0800;
    public const uint INPUT_KEYBOARD = 1, KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_KEYUP = 0x0002;
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion union; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
      // INPUT's union is sized by MOUSEINPUT on Windows. Omitting it makes
      // sizeof(INPUT) too small on x64 and causes SendInput to return zero.
      [FieldOffset(0)] public MOUSEINPUT mouse;
      [FieldOffset(0)] public KEYBDINPUT keyboard;
    }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
      public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
      public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo;
    }
    public static uint UnicodeText(string text) {
      uint sent = 0;
      foreach (char character in text.ToCharArray()) {
        var code = (int)character;
        var inputs = new List<INPUT>();
        inputs.Add(Key(code, false)); inputs.Add(Key(code, true));
        var result = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        sent += result;
        if (result != inputs.Count) return sent;
      }
      return sent;
    }
    private static INPUT Key(int scan, bool up) {
      return new INPUT { type = INPUT_KEYBOARD, union = new InputUnion {
        keyboard = new KEYBDINPUT { wScan = (ushort)scan, dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0) }
      }};
    }
  }
}
"@ -ReferencedAssemblies $references
}

function Read-Request {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { return $null }
  return $line | ConvertFrom-Json
}

function Write-Response($value, $error = $null) {
  if ($null -ne $error) {
    @{ ok = $false; error = [string]$error } | ConvertTo-Json -Compress -Depth 8
  } else {
    @{ ok = $true; value = $value } | ConvertTo-Json -Compress -Depth 12
  }
}

function Get-WindowRecord([IntPtr]$Handle) {
  if (-not [WebAgentBridge.Native]::IsWindow($Handle)) { throw "Window no longer exists." }
  $rect = New-Object WebAgentBridge.Native+RECT
  if (-not [WebAgentBridge.Native]::GetWindowRect($Handle, [ref]$rect)) { throw "Could not read window geometry." }
  $processId = 0
  [void][WebAgentBridge.Native]::GetWindowThreadProcessId($Handle, [ref]$processId)
  $titleBuffer = New-Object Text.StringBuilder 512
  [void][WebAgentBridge.Native]::GetWindowText($Handle, $titleBuffer, 512)
  $process = $null
  try { $process = Get-Process -Id $processId -ErrorAction Stop } catch {}
  $processName = if ($process) { $process.ProcessName } else { "unknown" }
  [pscustomobject]@{
    id = $Handle.ToInt64()
    title = $titleBuffer.ToString()
    app = $processName
    process = $processName
    processId = $processId
    x = $rect.Left
    y = $rect.Top
    width = [Math]::Max(0, $rect.Right - $rect.Left)
    height = [Math]::Max(0, $rect.Bottom - $rect.Top)
    state = if ($process -and $process.MainWindowHandle -eq $Handle) { "open" } else { "open" }
  }
}

function Get-WindowRecords {
  $items = @()
  foreach ($process in Get-Process) {
    try {
      if ($process.MainWindowHandle -eq 0) { continue }
      $record = Get-WindowRecord ([IntPtr]$process.MainWindowHandle)
      if ($record.title) { $items += $record }
    } catch {}
  }
  return $items
}

function Find-Window($request) {
  $handle = [IntPtr]::new([Int64]$request.id)
  $record = Get-WindowRecord $handle
  if ($request.app -and $record.process -ne $request.app -and $record.processId.ToString() -ne $request.app) {
    throw "Window identity changed."
  }
  return @{ handle = $handle; record = $record }
}

function Get-ScreenshotBase64($record) {
  $bitmap = New-Object System.Drawing.Bitmap ([Math]::Max(1, [int]$record.width)), ([Math]::Max(1, [int]$record.height))
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $stream = New-Object System.IO.MemoryStream
  try {
    $graphics.CopyFromScreen([int]$record.x, [int]$record.y, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return [Convert]::ToBase64String($stream.ToArray())
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
    $stream.Dispose()
  }
}

function Focus-Window($request) {
  $target = Find-Window $request
  if (-not [WebAgentBridge.Native]::SetForegroundWindow($target.handle)) { throw "Could not activate the requested window." }
  $deadline = [DateTime]::UtcNow.AddMilliseconds(750)
  while ([WebAgentBridge.Native]::GetForegroundWindow() -ne $target.handle -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 25
  }
  if ([WebAgentBridge.Native]::GetForegroundWindow() -ne $target.handle) {
    throw "The requested window did not become the foreground window."
  }
  return $target.record
}

function Invoke-Click($request) {
  $target = Find-Window $request
  [void][WebAgentBridge.Native]::SetForegroundWindow($target.handle)
  $x = $target.record.x + [int]$request.x
  $y = $target.record.y + [int]$request.y
  [void][WebAgentBridge.Native]::SetCursorPos($x, $y)
  $down = [WebAgentBridge.Native]::MOUSE_LEFT_DOWN
  $up = [WebAgentBridge.Native]::MOUSE_LEFT_UP
  if ($request.button -in @("right", "r")) { $down = [WebAgentBridge.Native]::MOUSE_RIGHT_DOWN; $up = [WebAgentBridge.Native]::MOUSE_RIGHT_UP }
  if ($request.button -in @("middle", "m")) { $down = [WebAgentBridge.Native]::MOUSE_MIDDLE_DOWN; $up = [WebAgentBridge.Native]::MOUSE_MIDDLE_UP }
  $count = if ($request.count) { [int]$request.count } else { 1 }
  for ($i = 0; $i -lt $count; $i++) {
    [WebAgentBridge.Native]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    [WebAgentBridge.Native]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    if ($i + 1 -lt $count) { Start-Sleep -Milliseconds 35 }
  }
  return $target.record
}

function Invoke-Scroll($request) {
  $target = Find-Window $request
  [void][WebAgentBridge.Native]::SetForegroundWindow($target.handle)
  [void][WebAgentBridge.Native]::SetCursorPos($target.record.x + [int]$request.x, $target.record.y + [int]$request.y)
  [WebAgentBridge.Native]::mouse_event([WebAgentBridge.Native]::MOUSE_WHEEL, 0, 0, [int]$request.delta, [UIntPtr]::Zero)
  return $target.record
}

function Get-EditableText([IntPtr]$handle) {
  if (-not $uiaAvailable) { return @{ supported = $false; text = "" } }
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    $elements = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    $texts = @()
    for ($i = 0; $i -lt $elements.Count; $i++) {
      $element = $elements.Item($i)
      try {
        $value = $element.GetCurrentPattern(
          [System.Windows.Automation.ValuePattern]::Pattern
        ).Current.Value
        if ($null -ne $value) { $texts += [string]$value }
        continue
      } catch {}
      try {
        $range = $element.GetCurrentPattern(
          [System.Windows.Automation.TextPattern]::Pattern
        ).DocumentRange
        $value = $range.GetText(-1)
        if ($null -ne $value) { $texts += [string]$value }
      } catch {}
    }
    return @{
      supported = $texts.Count -gt 0
      text = ($texts -join "`n")
    }
  } catch {
    return @{ supported = $false; text = "" }
  }
}

function Invoke-Type($request) {
  $target = Find-Window $request
  if (-not [WebAgentBridge.Native]::SetForegroundWindow($target.handle)) {
    throw "Could not activate the requested window."
  }
  $deadline = [DateTime]::UtcNow.AddMilliseconds(750)
  while ([WebAgentBridge.Native]::GetForegroundWindow() -ne $target.handle -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 25
  }
  if ([WebAgentBridge.Native]::GetForegroundWindow() -ne $target.handle) {
    throw "The requested window did not become the foreground window."
  }
  Start-Sleep -Milliseconds 75
  $expected = [string]$request.text
  $sent = [WebAgentBridge.Native]::UnicodeText($expected)
  if ($sent -ne ($expected.Length * 2)) {
    throw "Windows accepted only $sent of $($expected.Length * 2) keyboard events."
  }
  Start-Sleep -Milliseconds 100
  $verification = Get-EditableText $target.handle
  if (-not $verification.supported) {
    throw "Input was sent, but the target control does not expose readable text for verification."
  }
  if (-not $verification.text.Contains($expected)) {
    throw "Input was sent, but the target control did not contain the requested text."
  }
  return @{ window = $target.record; sent = $sent; verified = $true }
}

function Convert-Key([string]$key) {
  $parts = $key.Split("+") | ForEach-Object { $_.Trim() }
  $result = ""
  foreach ($part in $parts) {
    switch -Regex ($part.ToLowerInvariant()) {
      "^control(_l|_r)?$|^ctrl$" { $result += "^"; continue }
      "^alt(_l|_r)?$" { $result += "%"; continue }
      "^shift(_l|_r)?$" { $result += "+"; continue }
      "^return$|^enter$" { $result += "{ENTER}"; continue }
      "^escape$|^esc$" { $result += "{ESC}"; continue }
      "^backspace$" { $result += "{BACKSPACE}"; continue }
      "^tab$" { $result += "{TAB}"; continue }
      "^space$" { $result += " "; continue }
      "^up$" { $result += "{UP}"; continue }
      "^down$" { $result += "{DOWN}"; continue }
      "^left$" { $result += "{LEFT}"; continue }
      "^right$" { $result += "{RIGHT}"; continue }
      "^delete$|^del$" { $result += "{DELETE}"; continue }
      "^home$" { $result += "{HOME}"; continue }
      "^end$" { $result += "{END}"; continue }
      "^f([1-9]|1[0-2])$" { $result += "{$($part.ToUpperInvariant())}"; continue }
      default { $result += $part }
    }
  }
  return $result
}

function Invoke-Keypress($request) {
  $target = Find-Window $request
  [void][WebAgentBridge.Native]::SetForegroundWindow($target.handle)
  [System.Windows.Forms.SendKeys]::SendWait((Convert-Key ([string]$request.key)))
  return $target.record
}

function Invoke-Request($request) {
  switch ([string]$request.op) {
    "list_windows" { return Get-WindowRecords }
    "list_apps" {
      $groups = @{}
      foreach ($window in Get-WindowRecords) {
        if (-not $groups.ContainsKey($window.process)) { $groups[$window.process] = @() }
        $groups[$window.process] += $window
      }
      return @($groups.GetEnumerator() | ForEach-Object {
        [pscustomobject]@{ id = $_.Key; displayName = $_.Key; isRunning = $true; windows = @($_.Value) }
      })
    }
    "get_window" { return (Find-Window $request).record }
    "observe" {
      $target = Find-Window $request
      $record = $target.record
      $base64 = Get-ScreenshotBase64 $record
      return @{ window = $record; screenshot = $base64; width = $record.width; height = $record.height }
    }
    "launch_app" {
      Start-Process -FilePath ([string]$request.app) | Out-Null
      return @{ launched = $request.app }
    }
    "focus" { return Focus-Window $request }
    "click" { return Invoke-Click $request }
    "scroll" { return Invoke-Scroll $request }
    "type" { return Invoke-Type $request }
    "keypress" { return Invoke-Keypress $request }
    default { throw "Unknown desktop operation." }
  }
}

while ($true) {
  try {
    $request = Read-Request
    if ($null -eq $request) { break }
    Write-Response (Invoke-Request $request)
  } catch {
    Write-Response $null $_.Exception.Message
  }
  [Console]::Out.Flush()
}
