# Unattended updates (`alive update --auto` + watchdog)

`alive update --auto` is the unattended half: it decides whether an update is
allowed, applies it through the same safe path as a manual `alive update`, and
then exits. It never restarts or stops the harness. Restarting is the job of the
external watchdog in this directory, because a process cannot reliably replace
itself and then prove that the replacement came up.

```
deploy/update/
  alive-auto-update.sh       watchdog: update -> restart -> heartbeat check -> rollback
  alive-auto-update.service  oneshot systemd service that runs the watchdog
  alive-auto-update.timer    daily timer inside the maintenance window
```

## What `--auto` does

Every guard is logged, and a refused guard is a successful no-op (exit 0):

1. `updates.auto` is `true`;
2. local time is inside `updates.window` (`HH:MM-HH:MM`, empty = any time);
3. an update marker exists and is readable (`.alive-update.json`). This is the
   rollback baseline. A missing or corrupt marker is a no-op: run a manual
   `alive update` once after installing, then unattended updates can proceed;
4. the runtime is not busy. "Busy" means the heartbeat is younger than ~2
   minutes **and** `runtime.json` reports `status: "working"` (a run is in
   progress) or `"starting"`. A fresh heartbeat with an unreadable
   `runtime.json` is treated as busy, because idleness cannot be proven. A stale
   heartbeat means the runtime is down, so updating is safe;
5. origin has a stable `vX.Y.Z` tag newer than the current one.

Exit codes:

| code | meaning | watchdog action |
|---|---|---|
| `0`  | nothing to do (guard, or no newer tag) | stop |
| `1`  | apply failed; the automatic rollback already ran | stop, report failure |
| `10` | update applied and `.alive-update.json` has `restartRequested: true` | restart, verify heartbeat |

Anything else is treated as an error by the watchdog.

## Install

Prerequisites: Node.js >= 22 on the host, a clean git checkout, and the `alive`
CLI reachable from the service environment. The checkout must be on a branch or
a stable tag: `alive update` refuses a detached HEAD that is not a tag.

```bash
# 1. Put the checkout and the state directory where the service can read/write them.
#    The examples below assume:
#      repo:  /opt/alive
#      state: /opt/alive/.alive      (stateDir from alive.config.json)
#      user:  alive

# 2. Establish the rollback baseline once, by hand.
cd /opt/alive
./dist/index.js update --check
./dist/index.js update

# 3. Try the watchdog manually first. A missing/empty update should exit 0.
alive update --auto; echo "auto exit=$?"
sudo -u alive bash /opt/alive/deploy/update/alive-auto-update.sh \
  /opt/alive /opt/alive/.alive "alive restart"

# 4. Install the units. Edit ExecStart first: the three arguments must match
#    your paths and restart command.
sudo install -m 0644 deploy/update/alive-auto-update.service /etc/systemd/system/
sudo install -m 0644 deploy/update/alive-auto-update.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now alive-auto-update.timer

# 5. Inspect.
systemctl list-timers alive-auto-update.timer
systemctl status alive-auto-update.service
tail -n 100 /opt/alive/.alive/logs/auto-update.log
```

Enable automatic updates in `alive.config.json` as well - the timer alone is not
enough:

```json
"updates": {
  "auto": true,
  "window": "04:00-05:00",
  "heartbeatStaleMs": 300000,
  "restartCommand": ""
}
```

`restartCommand` can stay empty: the watchdog gets the command as its third
argument. Keeping it in one place (the unit) is easier to audit. If you also set
`updates.restartCommand`, keep the two identical.

## Choosing the restart command

The watchdog runs the command with `bash -c` from the repository directory. It
must start the harness and return; the watchdog then polls
`<state-dir>/heartbeat.json` for a `startedAt` newer than the moment before the
restart. Choose whatever supervises the process in your deployment:

| deployment | restart command |
|---|---|
| `alive run` daemon | `alive restart` |
| systemd service (recommended) | `systemctl restart alive.service` |
| container | `docker restart alive` or `podman restart alive` |
| custom supervisor | `supervisorctl restart alive` |

Rules:

- Quote the whole command as **one** argument in `ExecStart=`:
  `ExecStart=.../alive-auto-update.sh /opt/alive /opt/alive/.alive "alive restart"`.
- Use an absolute binary if systemd's `PATH` does not contain `alive`; the
  watchdog also honours `ALIVE_BIN=/usr/local/bin/alive` in an
  `Environment=` line.
- The command must not require interactivity and must not print secrets; its
  output is appended to the log.
- `alive restart` from the same checkout is usually right: it stops the old
  process and starts the newly built `dist/`.

Tuning (add `Environment=` lines to the service):

| variable | default | meaning |
|---|---|---|
| `ALIVE_BIN` | `alive` | CLI the watchdog invokes for `update --auto` / `--rollback` |
| `NODE_BIN` | `node` | used only to parse `heartbeat.json` and read the clock |
| `ALIVE_UPDATE_RESTART_TIMEOUT_SEC` | `180` | how long to wait for a fresh heartbeat |
| `ALIVE_UPDATE_POLL_INTERVAL_SEC` | `3` | heartbeat poll interval |

## Notifications

The watchdog exits `0` only when nothing needed doing or the new build came back
healthy. It exits non-zero after a failed update, a failed restart, or a
rollback, so systemd can report it. Pick one hook:

**`OnFailure=` (a notifier unit)**

```ini
# alive-auto-update.service
OnFailure=alive-update-notify@%n.service
```

`alive-update-notify@.service` is your own unit, for example:

```ini
[Unit]
Description=Notify about %i

[Service]
Type=oneshot
ExecStart=/usr/local/bin/alive-update-notify.sh %i
```

**`ExecStopPost=` (always runs, success and failure)**

```ini
# alive-auto-update.service
ExecStopPost=/usr/local/bin/alive-update-notify.sh %n
```

In the hook, read the result from `$SERVICE_RESULT` / `$EXIT_CODE` (systemd
provides them to `ExecStopPost`) and send a Telegram message, mail, or webhook.
Do not put tokens in the service unit: read them from an `EnvironmentFile=` with
mode `0600`, and never echo them into the log. The watchdog itself logs no
environment and no restart command; its full log is
`<state-dir>/logs/auto-update.log`.

## Disabling everything

From most to least surgical:

1. **Config switch (fast, keeps the timer installed):** set
   `"updates": { "auto": false, ... }`. The next watchdog run logs
   `updates.auto is false` and exits 0.
2. **Stop the timer:**
   ```bash
   sudo systemctl disable --now alive-auto-update.timer
   ```
   Manual runs of the service still work if started explicitly.
3. **Remove the units:**
   ```bash
   sudo systemctl disable --now alive-auto-update.timer
   sudo rm /etc/systemd/system/alive-auto-update.timer \
           /etc/systemd/system/alive-auto-update.service
   sudo systemctl daemon-reload
   ```
4. **Manual updates still work:** `alive update`, `alive update --check`,
   `alive update --status`, `alive update --rollback` are independent of
   `updates.auto` and the watchdog. Nothing else in the harness depends on this
   directory.

## Failure model

A failed start is only recoverable from outside the harness process: if the new
build cannot boot, the process that would perform a rollback is exactly the
process that is gone. That is why the watchdog, not `alive update --auto`,
restarts and verifies the heartbeat. If the new build does not produce a fresh
heartbeat within the timeout, the watchdog rolls back the checkout, restarts the
previous build, verifies it, and exits non-zero so systemd (or your notifier)
tells you that the update did not stick.
