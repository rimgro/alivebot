# systemd user units

This directory is the single source of truth for the Alive unit files. The host
is no longer where units are authored: edit the templates here, commit them, and
reinstall from the checkout. Hand-edited copies under `~/.config/systemd/user/`
are deployment state, not documentation, and will be overwritten the next time
the installer runs.

All units are installed in the **user** scope, under
`${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user`. That is the same scope the
runtime reports in `heartbeat.json` (`unitStatus` for managed profiles); there
are no system-scope Alive units in this directory.

```
deploy/systemd/
  alive.service              primary agent (default config)
  alive-agent@.service       managed profile, instance = profile id
  restart-limit.conf         drop-in for both units: start-loop guard (#178)
  browser-token.conf         drop-in for both units: shared browser host token
  install.sh                 idempotent installer
```

## Install

```bash
./deploy/systemd/install.sh                # install + enable alive.service
./deploy/systemd/install.sh editor reviewer # also enable alive-agent@editor, @reviewer
./deploy/systemd/install.sh --all-profiles  # enable every profile found in the checkout
```

Run the installer from the checkout: the repository root is resolved relative to
the script itself and it refuses to install if that directory has no `package.json`.

The installer copies the two units and both drop-ins into the user unit
directory, runs `loginctl enable-linger "$USER"`, `systemctl --user daemon-reload`
and `systemctl --user enable --now alive.service`.

Profiles are read from `.alive/agents/*/alive.config.json` in this checkout. With
no arguments the installer only prints the commands for the profiles it finds and
enables nothing:

```bash
systemctl --user enable --now alive-agent@editor
```

`ALIVE_SYSTEMD_SKIP_ACTIVATE=1` installs the files but prints the
`loginctl`/`systemctl` commands instead of running them. It is meant for tests and
sandboxes without a user systemd manager.

## Requirements

- A user systemd manager (`systemctl --user`) for the account that runs Alive.
- **Lingering enabled:** `loginctl enable-linger "$USER"`. Without it, user units
  stop when the last session ends and do not start after a reboot. The installer
  runs this and fails with an explicit message if it cannot; on hosts where it
  needs root/polkit, enable it once by hand and re-run the installer.
- `node` and the checkout at the paths pinned in the templates:
  - node: `%h/.local/share/node24/bin/node`
  - repo: `%h/Projects/alive`

The installer checks both before it touches anything and aborts with a clear
message if either is missing, instead of enabling a unit that cannot start (it
would fail on ExecStart and then sit in `start request repeated too quickly`).
`ALIVE_SYSTEMD_NODE_BIN` and `ALIVE_SYSTEMD_ENTRY` override the two paths it
verifies, for a host that keeps the checkout elsewhere.

If the checkout lives somewhere else, change the templates in this directory and
reinstall. Do not patch the host copies: the next install overwrites them.

## Browser token

`browser-token.conf` is installed into both `alive.service.d/` and
`alive-agent@.service.d/` and sets:

```ini
[Service]
Environment=ALIVE_BROWSER_SHARED_TOKEN_FILE=%h/.config/alive/browser-token
```

The token file lives at `~/.config/alive/browser-token` and must have mode `600`.
It is created separately from the installer: the installer only warns when it is
missing, because not every host runs the shared browser deployment. It never
creates the file and never changes its permissions.

Host divergence, for now: on the current host the base unit still points at
pi-node v22, and node24 plus the browser token are provided by a single local
`browser-deployment.conf` drop-in. After Rima's migration window the host moves
to the templates in this repository, where node24 and `browser-token.conf` are the
base state. The installer deletes a leftover `browser-deployment.conf` from both
drop-in directories (`removed legacy drop-in ...`) so it does not stay behind as
stale configuration next to the files this directory owns.

## Update after editing a template

```bash
git pull
./deploy/systemd/install.sh          # reinstall (idempotent)
systemctl --user daemon-reload       # the installer already does this, harmless to repeat
systemctl --user restart alive.service
systemctl --user restart 'alive-agent@editor'   # for each managed profile you changed
```

## Verify

```bash
systemctl --user status alive.service
systemctl --user status 'alive-agent@editor'
systemctl --user list-units 'alive-agent@*'
journalctl --user -u alive.service -n 100 --no-pager
```

## Telegram MCP proxy

`write:ask` profiles of the Telegram MCP proxy (`modules.telegram.mcp`) do not
send a write directly. The proxy writes a ticket file, the Telegram module of the
same profile shows an inline confirmation card, and the proxy performs the write
only after the operator presses **Отправить** (or refuses with **Отказ**).

The two processes share one directory: the proxy option
`profiles[].confirmation.ticketDir` and the runtime option
`modules.telegram.mcpConfirmation.ticketDir` must name the **same** directory
(a relative path is resolved against `paths.stateDir`). Tickets and decisions
live in `ticketDir/<profile>/`; do not point two profiles at the same subdirectory.

Confirmation card configuration (`modules.telegram.mcpConfirmation`):

```json
{
  "mcpConfirmation": {
    "ticketDir": "telegram-mcp-tickets",
    "chatId": 123456789,
    "operatorUserIds": [123456789],
    "pollMs": 2000
  }
}
```

- `chatId` — the only thread cards are sent to and the only chat a press is
  accepted from. A press from another chat or from a user id outside
  `operatorUserIds` is answered with «это не ваш запрос»; no decision is written.
- `operatorUserIds` — a non-empty list of numeric Telegram user ids allowed to
  approve or refuse a write.
- `ticketDir` — shared ticket root (see above).
- `pollMs` — scan interval, default 2000 ms.

Proxy side, per profile:

```json
{
  "name": "ops",
  "mode": "write:ask",
  "confirmation": { "ticketDir": "telegram-mcp-tickets", "ttlMs": 300000 }
}
```

Behaviour worth knowing before enabling it:

- **The profile module must be running.** If `modules.telegram.enabled` is off,
  the bot has no token or `mcpConfirmation` is absent, nobody sends the card:
  tickets stay pending until `ttlMs` and then the proxy denies the write. No
  automatic retry happens.
- **Step C / pi client timeout.** In the profile's `mcp.json` set
  `"timeout": 300` for this MCP server. pi's default is 30 s, which is shorter
  than a realistic operator answer. If the MCP client times out or aborts the
  HTTP request, the proxy closes the ticket as `denied`, a later decision is not
  accepted, and the message is **not** sent.
- **At most one send.** Before calling the upstream the proxy atomically marks
  the ticket `sending`. A proxy restarted while a ticket is `sending` turns it
  into `failed` and returns an error to the caller instead of sending again.
- **Backlog and cleanup.** At most 8 pending tickets per profile; a ninth ask is
  denied with a `confirmation backlog` reason and no ticket is written. Tickets
  and their decisions past their TTL are removed on proxy start and on every
  module scan.
- **Card failures.** If `sendMessage` for the card fails, the ticket is denied
  immediately with the reason instead of waiting for the TTL. Every press gets an
  `answerCallbackQuery`; the card is edited to its final state (sent, denied,
  expired, failed) without inline buttons, and a repeated press is a no-op.

## Out of scope

**System-scope units** are out of scope here and are not installed by this
installer: `alive-browser-host`, `alive-browser-tunnel@`,
`alive-browser-tunnel-watch` and `alive-dashboard`. They belong to the
host/browser deployment. (`deploy/browser/shared/alive-browser-host.service` is
such a browser-deployment example; it is not an Alive agent unit.)
