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
base state.

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

## Out of scope

**System-scope units** are out of scope here and are not installed by this
installer: `alive-browser-host`, `alive-browser-tunnel@`,
`alive-browser-tunnel-watch` and `alive-dashboard`. They belong to the
host/browser deployment. (`deploy/browser/shared/alive-browser-host.service` is
such a browser-deployment example; it is not an Alive agent unit.)
