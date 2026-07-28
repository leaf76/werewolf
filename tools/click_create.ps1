Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinClick {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
  public const uint LEFTDOWN = 0x02;
  public const uint LEFTUP = 0x04;
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Click-At([int]$x, [int]$y) {
  [WinClick]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 60
  [WinClick]::mouse_event([WinClick]::LEFTDOWN, 0, 0, 0, 0)
  Start-Sleep -Milliseconds 40
  [WinClick]::mouse_event([WinClick]::LEFTUP, 0, 0, 0, 0)
}

$gwin = Get-Process | Where-Object { $_.MainWindowTitle -eq "Werewolf (DEBUG)" } | Select-Object -First 1
if (-not $gwin) {
  $exe = "C:\Users\doxc_\Downloads\Godot_v4.7.1-stable_win64.exe\Godot_v4.7.1-stable_win64.exe"
  Start-Process -FilePath $exe -ArgumentList "--path", "C:\Users\doxc_\Workspace\werewolf-godot"
  Start-Sleep 5
  $gwin = Get-Process | Where-Object { $_.MainWindowTitle -eq "Werewolf (DEBUG)" } | Select-Object -First 1
}
if (-not $gwin) { Write-Output "NO_WINDOW"; exit 1 }

$hwnd = $gwin.MainWindowHandle
$r = New-Object WinClick+RECT
[WinClick]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
Write-Output "rect L=$($r.Left) T=$($r.Top) W=$w H=$h"

[WinClick]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 400
$cx = [int](($r.Left + $r.Right) / 2)

# name field
Click-At $cx ([int]($r.Top + $h * 0.40))
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 80
[System.Windows.Forms.SendKeys]::SendWait("TestA")
Start-Sleep -Milliseconds 300

# create button
Click-At $cx ([int]($r.Top + $h * 0.53))
Start-Sleep -Seconds 5

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$path = "C:\Users\doxc_\Workspace\werewolf-godot\debug_create_result.png"
$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
$gwin.Refresh()
Write-Output "title=$($gwin.MainWindowTitle)"
Write-Output "saved $path"
