# The armed shutdown's countdown, as a DESKTOP window - Windows half of
# platform.countdownCommand(). See src/platform/win32.js.
#
# VS Code's own countdown notification is only any use if you are looking at VS Code, and
# the whole premise of the armed gear is that you are not: you walked away, and the
# machine is about to power off. So the countdown also comes up as a window of its own -
# always on top, ticking every second, with a Cancel button big enough to hit in a hurry.
#
# A FILE rather than an inline -Command string: this is 60 lines of WinForms, and passing
# it through cmd.exe's quoting would be a bug farm. Run as:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File countdown.ps1 -Seconds 120 ...
#
# The EXIT CODE is the answer, and the contract is "nonzero means do not power off BY
# ITSELF":
#   0  the countdown ran out - and nothing else exits 0
#   3  the user pressed "<action> now": skip the rest of the WAIT, not the checks
#   1  cancelled - the Cancel button, Escape, or closing the window
#
# The two nonzero answers each print CHUTDOWN:NOW:<token> or CHUTDOWN:CANCEL:<token>, and
# that line is what the extension actually reads. A bare exit code is three bits of
# provenance-free data and the set of things that can set one is open-ended - a future
# PowerShell, a wrapper, an antivirus shim - whereas a process that never started cannot
# print a token that was minted a millisecond before it was launched. Nonzero with NEITHER
# token is a window that never appeared, and the machine stays on.
#
# Closing the window counts as cancelling on purpose. It is ambiguous, and the safe
# reading of an ambiguous answer is the one that does not power the machine off.
param(
    [int]$Seconds = 120,
    [string]$Title = 'Chutdown',
    [string]$Message = 'Every Claude session has finished.',
    [string]$Action = 'shutdown',
    [string]$Token = ''
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Mutated through the reference, not by name: a `$script:` assignment inside a .NET
# event handler does not reliably land in this scope, and the run-out path silently
# read as "cancelled" - which meant an armed shutdown that never fired.
$state = @{ left = $Seconds; expired = $false; now = $false }

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.ClientSize = New-Object System.Drawing.Size(460, 190)
$form.FormBorderStyle = 'FixedDialog'
$form.StartPosition = 'CenterScreen'
$form.MinimizeBox = $false
$form.MaximizeBox = $false
$form.TopMost = $true
$form.ShowInTaskbar = $true

$head = New-Object System.Windows.Forms.Label
$head.Text = $Message
$head.SetBounds(20, 18, 420, 40)
$head.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.Controls.Add($head)

$count = New-Object System.Windows.Forms.Label
$count.SetBounds(20, 58, 420, 46)
$count.TextAlign = 'MiddleCenter'
$count.Font = New-Object System.Drawing.Font('Segoe UI', 20, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($count)

$note = New-Object System.Windows.Forms.Label
$note.Text = "until this machine runs $Action."
$note.SetBounds(20, 104, 420, 22)
$note.TextAlign = 'MiddleCenter'
$note.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$form.Controls.Add($note)

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel - stay on'
$cancel.SetBounds(250, 138, 190, 34)
$cancel.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.Controls.Add($cancel)

$now = New-Object System.Windows.Forms.Button
$now.Text = "$Action now"
$now.SetBounds(20, 138, 150, 34)
$form.Controls.Add($now)

# Escape cancels; the Cancel button is the default, so a stray Enter does not power the
# machine off either.
$form.AcceptButton = $cancel
$form.CancelButton = $cancel

function Show-Left {
    $m = [int][Math]::Floor($state.left / 60)
    $s = $state.left % 60
    if ($m -gt 0) { $count.Text = ('{0}:{1:d2}' -f $m, $s) } else { $count.Text = "$($state.left)s" }
}
Show-Left

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
    $state.left--
    if ($state.left -le 0) {
        $state.expired = $true
        $timer.Stop()
        $form.Close()
    } else {
        Show-Left
    }
})

$cancel.Add_Click({ $timer.Stop(); $form.Close() })
$now.Add_Click({ $state.now = $true; $timer.Stop(); $form.Close() })
# Brought to the front on show: a countdown behind the browser is no countdown at all.
$form.Add_Shown({ $form.Activate(); $timer.Start() })

[void]$form.ShowDialog()

if ($state.now) {
    # Only this line prints the NOW token, and it is only reached from the click handler.
    # [Console]::Out rather than Write-Output: no pipeline, no formatting, explicit flush.
    [Console]::Out.WriteLine("CHUTDOWN:NOW:$Token")
    [Console]::Out.Flush()
    exit 3
}
if ($state.expired) { exit 0 }
[Console]::Out.WriteLine("CHUTDOWN:CANCEL:$Token")
[Console]::Out.Flush()
exit 1
