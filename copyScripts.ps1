$sourceDir = ".\dist2\*"
$destinationDir = "C:\Users\tarolrr\AppData\Local\Screeps\scripts\screeps.com\main"

Copy-Item -Path $sourceDir -Destination $destinationDir -Recurse -Force