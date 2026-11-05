#!/bin/sh
# Install the Alive systemd user units from this checkout.
#
# The repository is the single source of truth for the unit files: this script
# copies deploy/systemd/* into the user unit directory, reloads the user
# manager and enables the primary unit. Re-run it after editing a template.
set -eu

usage() {
	cat <<'EOF'
Usage: deploy/systemd/install.sh [--all-profiles] [profile ...]

Install alive.service, alive-agent@.service and the restart-limit/browser-token
drop-ins into ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user, reload the user
manager and enable alive.service.

Without profile arguments, print the command that enables each managed profile
found in .alive/agents/*/alive.config.json (nothing is enabled). With profile
arguments, enable alive-agent@<profile> for each id. --all-profiles enables
every profile found in this checkout.

Set ALIVE_SYSTEMD_SKIP_ACTIVATE=1 to install the files but print the
loginctl/systemctl commands instead of running them (used in tests and
sandboxes without a user systemd manager).
EOF
}

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

# Repository root is two levels above this script (deploy/systemd/install.sh).
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)

skip_activate=0
case "${ALIVE_SYSTEMD_SKIP_ACTIVATE:-}" in
1 | true | yes) skip_activate=1 ;;
esac

all_profiles=0
profiles=''

for arg in "$@"; do
	case "$arg" in
	--all-profiles) all_profiles=1 ;;
	-h | --help)
		usage
		exit 0
		;;
	-*) die "unknown option: $arg (try --help)" ;;
	*) profiles="$profiles $arg" ;;
	esac
done

validate_profile() {
	case "$1" in
	'' | *[!A-Za-z0-9._-]*) die "invalid profile id: '$1'" ;;
	esac
}

find_profiles() {
	for config in "$repo_dir"/.alive/agents/*/alive.config.json; do
		[ -f "$config" ] || continue
		profile=${config%/alive.config.json}
		printf '%s\n' "${profile##*/}"
	done
}

enable_profile() {
	if [ "$skip_activate" = 1 ]; then
		printf '[skip] systemctl --user enable --now alive-agent@%s\n' "$1"
	else
		printf 'Enabling alive-agent@%s\n' "$1"
		systemctl --user enable --now "alive-agent@$1"
	fi
}

user=${USER:-$(id -un)}
if [ -n "${XDG_CONFIG_HOME:-}" ]; then
	config_home=$XDG_CONFIG_HOME
elif [ -n "${HOME:-}" ]; then
	config_home=$HOME/.config
else
	die "neither XDG_CONFIG_HOME nor HOME is set"
fi
unit_dir=$config_home/systemd/user

printf 'Installing Alive systemd user units from %s\n' "$repo_dir"
install -d "$unit_dir/alive.service.d" "$unit_dir/alive-agent@.service.d"
install -m 0644 "$script_dir/alive.service" "$unit_dir/alive.service"
install -m 0644 "$script_dir/alive-agent@.service" "$unit_dir/alive-agent@.service"
install -m 0644 "$script_dir/restart-limit.conf" "$unit_dir/alive.service.d/restart-limit.conf"
install -m 0644 "$script_dir/restart-limit.conf" "$unit_dir/alive-agent@.service.d/restart-limit.conf"
install -m 0644 "$script_dir/browser-token.conf" "$unit_dir/alive.service.d/browser-token.conf"
install -m 0644 "$script_dir/browser-token.conf" "$unit_dir/alive-agent@.service.d/browser-token.conf"
printf 'Installed units in %s\n' "$unit_dir"

# The shared browser host reads its token from this path (see browser-token.conf).
# The installer never creates or chmods it: not every host has a browser deployment.
if [ -n "${HOME:-}" ] && [ ! -e "$HOME/.config/alive/browser-token" ]; then
	printf 'note: %s does not exist.\n' "$HOME/.config/alive/browser-token" >&2
	printf 'The browser-token drop-in points ALIVE_BROWSER_SHARED_TOKEN_FILE at it;\n' >&2
	printf 'create the token file with mode 600 separately if this host runs the shared browser host.\n' >&2
fi

# Without lingering, user units are stopped when the last session ends and do
# not come back after a reboot.
if [ "$skip_activate" = 1 ]; then
	printf '[skip] loginctl enable-linger %s\n' "$user"
else
	if ! loginctl enable-linger "$user"; then
		printf 'error: loginctl enable-linger %s failed.\n' "$user" >&2
		printf 'The units are installed, but user services will not stay up without lingering.\n' >&2
		printf 'Enable it manually (it may need root/polkit) and re-run this script.\n' >&2
		exit 1
	fi
fi

if [ "$skip_activate" = 1 ]; then
	printf '[skip] systemctl --user daemon-reload\n'
	printf '[skip] systemctl --user enable --now alive.service\n'
else
	systemctl --user daemon-reload
	systemctl --user enable --now alive.service
fi

if [ "$all_profiles" = 1 ]; then
	found=$(find_profiles)
	if [ -n "$found" ]; then
		profiles="$profiles $found"
	fi
fi

if [ -n "$profiles" ]; then
	for profile in $profiles; do
		validate_profile "$profile"
		enable_profile "$profile"
	done
else
	found=$(find_profiles)
	if [ -z "$found" ]; then
		printf 'No managed profiles found in %s/.alive/agents/*/alive.config.json.\n' "$repo_dir"
	else
		printf 'Managed profiles found. Enable them with:\n'
		for profile in $found; do
			printf '  systemctl --user enable --now alive-agent@%s\n' "$profile"
		done
	fi
fi
