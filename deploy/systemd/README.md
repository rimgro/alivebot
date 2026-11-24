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
  alive-telegram-mcp.service host-side MCP proxy for the Telegram account (#264)
  restart-limit.conf         drop-in for the agent units: start-loop guard (#178)
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

The installer copies the units and drop-ins into the user unit directory, runs
`loginctl enable-linger "$USER"`, `systemctl --user daemon-reload` and
`systemctl --user enable --now alive.service`. `alive-telegram-mcp.service` is
copied but never enabled by the installer: it only makes sense once
`modules.telegram.mcp` is configured (see below).

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

## Telegram MCP proxy (#264)

`alive-telegram-mcp.service` runs `alive telegram-mcp serve` on the host. The
agent VM never talks to Telegram: the proxy owns one bearer token per profile,
spawns `telegram mcp` (better-tg-cli, stdio) as a child per profile and answers
on `127.0.0.1:8787/mcp`. The Telegram session stays on the host, the proxy holds
no session of its own and needs no Secret Service/keyring.

Configure it in the config the unit passes to `--config` (`alive.config.json` in
the checkout; the root config, not a profile one):

```json
"modules": {
  "telegram": {
    "mcp": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 8787,
      "profiles": [
        {
          "name": "developer",
          "mode": "write:ask",
          "allowChats": ["-1004219230108"],
          "writeTtlMs": 900000,
          "writeLimitPerHour": 20
        }
      ]
    }
  }
}
```

`name` is the profile id the token is issued for; `mode` is `read`,
`write:ask` (default) or `write:auto`; `allowChats` is the exact list of chat
ids/@usernames `telegram_read` may read (empty means none). `command`/`args`
default to `telegram mcp`, and `env` is the only way to add a variable to the
child beyond the fixed exact-name allowlist (PATH, HOME, locale, XDG, temp,
proxy; no Telegram credentials).

`enabled: true` is required: `serve` refuses to listen while it is false, so do
not enable the unit before the block is configured. The proxy is meant for the
host runtime only — nothing in the sandbox talks to it directly at this step.

### Tokens

Tokens are printed once and stored only as hashes under
`<stateDir>/telegram-mcp/tokens.json` (0600, directory 0700), with
`<stateDir>` = `.alive` of the root config. Issue one per profile after the
config is in place:

```bash
cd ~/Projects/alive
node dist/index.js telegram-mcp token developer    # prints the token once
node dist/index.js telegram-mcp revoke developer   # drops it, serves no one
```

Keep the token out of the repository, shell history and chat: it belongs in the
profile's `mcp.json` in the VM (step C) with mode 600. Revoking one profile
leaves the others untouched.

### Install and run

```bash
./deploy/systemd/install.sh                                  # copies the unit
systemctl --user daemon-reload
systemctl --user enable --now alive-telegram-mcp.service     # only after the config block
journalctl --user -u alive-telegram-mcp -n 100 --no-pager
```

The upstream child needs an authenticated better-tg-cli session on the host
(`telegram auth`, step D of #264) in `~/.config/tg` or the keyring the CLI
picks. Without it the proxy starts, but `tools/list` fails with an upstream
error.

### Verify

```bash
# no token: 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# with the profile token: three tools, and a read outside allowChats is denied
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Policy denials are JSON-RPC tool results (`isError: true`), not HTTP errors:
`401` means a missing or unknown bearer token, and only that. Every decision is
appended to `<stateDir>/audit/telegram-mcp.jsonl` (0600).

`write:ask` currently answers "confirmation required" with a ticket id and sends
nothing anywhere; the confirmation card in the profile thread is a separate
follow-up PR (#264, step B2).

## Out of scope

**System-scope units** are out of scope here and are not installed by this
installer: `alive-browser-host`, `alive-browser-tunnel@`,
`alive-browser-tunnel-watch` and `alive-dashboard`. They belong to the
host/browser deployment. (`deploy/browser/shared/alive-browser-host.service` is
such a browser-deployment example; it is not an Alive agent unit.)
