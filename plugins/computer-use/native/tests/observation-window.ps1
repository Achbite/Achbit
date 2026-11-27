# Disposable interactive target for windows-observation.mjs. No external application or input hook.
param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework
$window=New-Object Windows.Window
$window.Title='Achbit Computer Use observation fixture'; $window.Width=680; $window.Height=480
$panel=New-Object Windows.Controls.StackPanel; $window.Content=$panel
function Button([string]$label) { $b=New-Object Windows.Controls.Button; $b.Content=$label; $b.Height=36; $null=$panel.Children.Add($b); return $b }
$reveal=Button 'Reveal synthetic history'; $next=Button 'Verify retained control'
$rows=@(for ($i=0;$i -lt 48;$i++) { $n=New-Object Windows.Controls.TextBlock; $n.Text="Short row $i"; $null=$panel.Children.Add($n); $n })
$script:clicks=0; $script:presses=0
function SaveCounts { [IO.File]::WriteAllText((Join-Path $Directory 'counts.json'),(@{ clicks=$script:clicks; presses=$script:presses }|ConvertTo-Json -Compress)) }
$reveal.Add_Click({ $script:clicks++; foreach ($r in $rows) { [Windows.Automation.AutomationProperties]::SetName($r, ('ROW-BEGIN:'+('abcd' * 16384)+':ROW-END')) }; SaveCounts })
$next.Add_Click({ $script:presses++; SaveCounts })
$window.Add_ContentRendered({ $handle=(New-Object Windows.Interop.WindowInteropHelper $window).Handle.ToInt64(); SaveCounts; $tmp=Join-Path $Directory 'target.tmp'; [IO.File]::WriteAllText($tmp,(@{ pid=$PID; windowId=$handle; app=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName }|ConvertTo-Json -Compress)); [IO.File]::Move($tmp,(Join-Path $Directory 'target.json')) })
$timer=New-Object Windows.Threading.DispatcherTimer; $timer.Interval=[TimeSpan]::FromMilliseconds(200); $timer.Add_Tick({ if (Test-Path -LiteralPath (Join-Path $Directory 'stop-window')) { $timer.Stop(); $window.Close() } }); $timer.Start()
$null=$window.ShowDialog()
