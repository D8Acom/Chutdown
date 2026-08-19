<p align="center">
  <img src="media/icon.png" width="110" alt="Chutdown">
</p>

# Chutdown

<p align="center">
  <img src="https://img.shields.io/badge/%20-0078D6?style=for-the-badge&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0wIDBoMTEuMzc3djExLjM3Mkgwem0xMi42MjMgMEgyNHYxMS4zNzJIMTIuNjIzek0wIDEyLjYyOGgxMS4zNzdWMjRIMHptMTIuNjIzIDBIMjRWMjRIMTIuNjIzeiIvPjwvc3ZnPg%3D%3D" alt="Windows">
  <img src="https://img.shields.io/badge/%C2%B7%20untested-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS: untested — everything is implemented, but not tested on a real Mac">
  <img src="https://img.shields.io/badge/%C2%B7%20untested-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux: untested — everything is implemented, systemctl poweroff included, but none of it has been run on a real Linux desktop">
</p>


<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=d8a.chutdown"><img src="https://img.shields.io/badge/%C2%B7%20download-0066B8?style=for-the-badge&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0yMy4xNSAyLjU4N0wxOC4yMS4yMWExLjQ5NCAxLjQ5NCAwIDAwLTEuNzA1LjI5bC05LjQ2IDguNjMtNC4xMi0zLjEyOGEuOTk5Ljk5OSAwIDAwLTEuMjc2LjA1N0wuMzI3IDcuMjYxQTEgMSAwIDAwLjMyNiA4Ljc0TDMuODk5IDEyIC4zMjYgMTUuMjZhMSAxIDAgMDAuMDAxIDEuNDc5TDEuNjUgMTcuOTRhLjk5OS45OTkgMCAwMDEuMjc2LjA1N2w0LjEyLTMuMTI4IDkuNDYgOC42M2ExLjQ5MiAxLjQ5MiAwIDAwMS43MDQuMjlsNC45NDItMi4zNzdBMS41IDEuNSAwIDAwMjQgMjAuMDZWMy45MzlhMS41IDEuNSAwIDAwLS44NS0xLjM1MnptLTUuMTQ2IDE0Ljg2MUwxMC44MjYgMTJsNy4xNzgtNS40NDh2MTAuODk2eiIvPjwvc3ZnPg%3D%3D" alt="VS Code Marketplace: download"></a>

</p>

<img src="media/screenshots/statusbar.png" width="1070" alt="The Chutdown status bar: the shutdown toggle, the .terminals button, a launch button per model, one traffic light per session, the idle dropdown and the usage meter">

*Shutdown your computer(or notify) when all tasks are finished, run terminal servers minimized, launch a specific claude model 50% faster than claude code, See the progress of your current sessions (and idle sessions), see your claude usage at all times.*

## Launch buttons

<img src="media/screenshots/editor-buttons.png" width="790" alt="The O / F / S / H buttons top right in the editor title bar, with the F button's hover: Fable - the most capable model, and the priciest">

*One click per model, 2x faster loading time and 100x faster than running /models.*
[Details →](docs/MANUAL.md#claude-tabs-with-renamed-titles--the-launch-buttons)

## View usage instantly
<img src="media/screenshots/hover-usage.png" width="658" alt="The usage meter's hover: Session, Weekly all-models and Weekly Fable limits as bars, with percent left and reset times">

*See your `/usage` limits, without leaving the status bar — and click the meter to step
past a limit that is already spent, so a weekly window at 0% left stops being the only
number you can see.*
[Details →](docs/MANUAL.md#pulse-52--claude-usage-meter)

## off / sound / notify / shutdown

<img src="media/screenshots/hover-gear.png" width="810" alt="The gear toggle's hover: click for sound only — a chime when every Claude session finishes — click again to arm shutdown">

*When your sessions finish: 
1. stay quiet. 
2. chime. 
3. pop up a notification. 
4. turn off computer. 

read from the transcript's own `stop_reason`, never guessed from silence.*
[Details →](docs/MANUAL.md#power-status-off--sound--notify--shutdown)

## The footer bar — every session at a glance

<img src="media/screenshots/hover-session.png" width="790" alt="Hovering a green traffic light: processing, quiet 7s, the latest output, the first and latest prompt, and a Copy text link">:

*See all your claude tasks and status: 
1. 🟢 Processing task. 
2. 🟠 Requires prompt. 
3. 🔴 Task has finished.

Hover to see the task details — the latest output, plus the prompt it started on and the one you last sent; click to jump to it. Initial tasks are renamed based on the initial prompt.*
[Details →](docs/MANUAL.md#traffic-lights--one-clickable-entry-per-session)

<img src="media/screenshots/hover-idle.png" width="703" alt="The idle dropdown's hover: nine idle sessions listed by name with how each ended and how long it has been quiet — click a name to resume it">

*Old sessions turn idle but still redeemable — one click to run again,
no `claude --resume` picker.*
[Details →](docs/MANUAL.md#after-a-reload-or-a-restart)

## Terminals

<img src="media/screenshots/tabs.png" alt="Terminal tabs renamed to one-word session names, each carrying its live traffic light emoji, with the O / F letter launch buttons top right">

*"npm run start" your project with one click and allow agents to restart the app as well.*
[Details →](docs/MANUAL.md#claude-tabs-with-renamed-titles--the-launch-buttons)

`.terminals` — batch multiple processes as well.

```json
{
  "dev": "npm run dev",                                                // workspace root
  "web": { "cmd": "npm run dev", "port": 3000 },                       // root too, with a port probe
  "api": { "cmd": "npm run dev", "cwd": "packages/api", "port": 4000 } // custom folder
}
```

`cwd` is the only thing that picks a folder: leave it out, like `web` above, and the
entry runs in the workspace root. A one-line syntax is read too, so a single app in the
folder you are already in is one line — `name:port = command`, no folder anywhere:

```
dev:3000 = npm run dev
```

<img src="media/screenshots/terminals-active.png" width="889" alt="Hovering a batch terminal's light: npm run dev, port 3013 DOWN - click to restart, the latest log lines and a Copy log link">

*Declare your dev servers once: each gets a light with its latest log in the hover,
its port is freed before launch, and one button stops them all.*

**And the agent in the repo can restart them itself** — no mouse, no asking you to
click:

```
code --open-url "vscode://d8a.chutdown/restart?name=web&ws=C:/path/to/this/folder"
```

*`/start`, `/stop` and `/restart`, all of them or one by name, straight from the shell
your session already has. It edits a file, it restarts the server, it re-reads the log
in the hover.*
[Details →](docs/MANUAL.md#run-all-terminals--batch-terminals)

## Choose your favorite models

<img src="media/screenshots/hover-model.png" width="830" alt="The fable launch button's hover: Claude Fable 5, what it is best used for, and a Choose models link">

***Choose models** — Choose what models you want to show and hover to see their use-case.*
*The buttons you start with follow your plan — no Fable button on a Pro account with no
usage credits — and the picker still lets you tick anything.*
[Details →](docs/MANUAL.md#claude-tabs-with-renamed-titles--the-launch-buttons)

## Install

**Requirements:** VS Code 1.93+, and the [Claude Code](https://claude.com/claude-code)
CLI installed and signed in.

**From the Marketplace** — search *Chutdown* in the Extensions view, or from a terminal:

```sh
code --install-extension d8a.chutdown
```

**From a `.vsix`** — download it from the
[latest release](https://github.com/D8Acom/Chutdown/releases/latest)

```sh
git clone https://github.com/D8Acom/Chutdown.git
```