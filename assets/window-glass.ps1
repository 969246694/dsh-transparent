# ============================================================================
#  window-glass.ps1 - invoked by the HOST half of dsh-transparent at startup.
#
#  Applies window transparency (DWM backdrop + optional whole-window alpha) to
#  the DSH desktop window.
#
#  Why a helper at all: window transparency is a Win32/DWM property of the OS
#  window. It only exists once the window exists, and the handle changes on
#  every client restart. Page CSS cannot reach it, so the plugin's host half
#  (Node) spawns this script.
#
#  ENCODING: keep this file pure ASCII.
#  Windows PowerShell 5.1 reads .ps1 as ANSI unless a BOM is present. A UTF-8
#  file without a BOM turns non-ASCII comments into mojibake, and a stray byte
#  inside a string can break parsing outright - which is exactly what happened
#  once with Chinese comments here.
#
#  Params:
#    -Alpha <0-255>   whole-window opacity. 255 = do not fade (backdrop only).
#    -Retries <n>     how many times to poll for the window. Default 40.
#    -Watch <sec>     keep watching and re-apply if the app resets the style.
# ============================================================================

param(
  [ValidateRange(0, 255)][int]$Alpha = 215,
  [int]$Retries = 40,
  [int]$Watch = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WG {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLongW(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint k, byte a, uint f);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int size);
}
'@

$WS_EX_LAYERED = 0x80000
$LWA_ALPHA = 2
$SWP_FLAGS = 0x27

function Find-DshWindow {
  $procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { return [IntPtr]::Zero }
  $script:pids = @($procs | ForEach-Object { $_.Id })
  $script:found = [IntPtr]::Zero
  $script:bestArea = 0
  $cb = [WG+EnumProc]{
    param($h, $l)
    if (-not [WG]::IsWindowVisible($h)) { return $true }
    $p = 0
    [void][WG]::GetWindowThreadProcessId($h, [ref]$p)
    if ($script:pids -notcontains $p) { return $true }

    # Do NOT match on the window title. During early startup the title is empty,
    # which made the first version of this script give up before the window had
    # a name. Identify the main window by shape: the largest visible top-level
    # window owned by the app. DevTools and dialogs are far smaller.
    $len = [WG]::GetWindowTextLengthW($h)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len + 2)
      [void][WG]::GetWindowTextW($h, $sb, $sb.Capacity)
      $t = $sb.ToString()
      if ($t -like '*Developer Tools*' -or $t -like '*DevTools*') { return $true }
    }

    $r = New-Object WG+RECT
    if (-not [WG]::GetWindowRect($h, [ref]$r)) { return $true }
    $ww = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    if ($ww -lt 700 -or $hh -lt 500) { return $true }
    $area = $ww * $hh
    if ($area -gt $script:bestArea) {
      $script:bestArea = $area
      $script:found = $h
    }
    return $true
  }
  [void][WG]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:found
}

function Apply-Alpha {
  if ($Alpha -lt 255) {
    $ex = [WG]::GetWindowLongW($w, -20)
    if (-not ($ex -band $WS_EX_LAYERED)) {
      [void][WG]::SetWindowLongW($w, -20, ($ex -bor $WS_EX_LAYERED))
    }
    [void][WG]::SetLayeredWindowAttributes($w, 0, [byte]$Alpha, $LWA_ALPHA)
    [void][WG]::SetWindowPos($w, [IntPtr]::Zero, 0, 0, 0, 0, $SWP_FLAGS)
  } else {
    $ex = [WG]::GetWindowLongW($w, -20)
    if ($ex -band $WS_EX_LAYERED) {
      [void][WG]::SetWindowLongW($w, -20, ($ex -band (-bnot $WS_EX_LAYERED)))
      [void][WG]::SetWindowPos($w, [IntPtr]::Zero, 0, 0, 0, 0, $SWP_FLAGS)
    }
  }
}

# Poll for the window: the host starts before the window is created.
$w = [IntPtr]::Zero
for ($i = 0; $i -lt $Retries; $i++) {
  $w = Find-DshWindow
  if ($w -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 400
}

if ($w -eq [IntPtr]::Zero) {
  Write-Output 'dsh-transparent: no DSH window found, skipped'
  exit 0
}

# 1) DWM backdrop. Keep the app's own Mica (2) and re-assert it once.
$backdrop = 2
[void][WG]::DwmSetWindowAttribute($w, 38, [ref]$backdrop, 4)

# 2) Apply the whole-window alpha.
Apply-Alpha

# 3) Watch.
# Applying once at startup is NOT enough. The app keeps manipulating the window
# while it finishes starting (show / setBounds / state changes), and each of
# those makes Electron rewrite the window style, clearing WS_EX_LAYERED. This
# was observed directly: same hwnd, the LAYERED bit went back to 0 shortly after
# a successful apply. So keep watching and put it back whenever it is cleared.
if ($Watch -gt 0) {
  $end = (Get-Date).AddSeconds($Watch)
  $reApplied = 0
  while ((Get-Date) -lt $end) {
    Start-Sleep -Milliseconds 1500
    if ($Alpha -lt 255) {
      $ex = [WG]::GetWindowLongW($w, -20)
      if (-not ($ex -band $WS_EX_LAYERED)) {
        Apply-Alpha
        $reApplied++
      }
    }
  }
  Write-Output ("dsh-transparent: alpha={0} hwnd=0x{1:X} watched={2}s reapplied={3}" -f $Alpha, $w.ToInt64(), $Watch, $reApplied)
  exit 0
}

Write-Output ("dsh-transparent: alpha={0} hwnd=0x{1:X}" -f $Alpha, $w.ToInt64())

