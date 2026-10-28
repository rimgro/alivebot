#!/usr/bin/env bash
#
# External watchdog for `alive update --auto`.
#
#   alive-auto-update.sh <repo-dir> <state-dir> <restart-command>
#
# 1. Runs `alive update --auto`:
#      0  -> nothing to do, exit 0
#      1  -> update failed and was already rolled back, exit 1
#      10 -> update applied, continue to the restart
# 2. Records the current time, runs the restart command, then polls
#    <state-dir>/heartbeat.json until its `startedAt` is newer than that moment
#    (default timeout 180 s, override with ALIVE_UPDATE_RESTART_TIMEOUT_SEC).
# 3. A fresh heartbeat means the new build started: log success, exit 0.
# 4. No fresh heartbeat means the new build did not start: roll back with
#    `alive update --rollback`, run the restart command again, poll again, and
#    exit non-zero. Every step goes to <state-dir>/logs/auto-update.log.
#
# This script is the only thing that restarts the harness. It never touches the
# repository itself and never logs the restart command (it may contain secrets).
#
# Environment overrides:
#   ALIVE_BIN                        alive executable (default: alive)
#   NODE_BIN                         node executable (default: node)
#   ALIVE_UPDATE_RESTART_TIMEOUT_SEC seconds to wait for a fresh heartbeat (180)
#   ALIVE_UPDATE_POLL_INTERVAL_SEC   poll interval in seconds (3)

set -euo pipefail

readonly ALIVE_BIN="${ALIVE_BIN:-alive}"
readonly NODE_BIN="${NODE_BIN:-node}"
readonly RESTART_TIMEOUT_SEC="${ALIVE_UPDATE_RESTART_TIMEOUT_SEC:-180}"
readonly POLL_INTERVAL_SEC="${ALIVE_UPDATE_POLL_INTERVAL_SEC:-3}"

usage() {
	cat >&2 <<'EOF'
usage: alive-auto-update.sh <repo-dir> <state-dir> <restart-command>

  repo-dir          Alive checkout; `alive update --auto` runs from here
  state-dir         directory holding heartbeat.json and logs/ (for example <repo>/.alive)
  restart-command   command that starts the harness, run with bash -c
                    (for example "alive restart" or "systemctl restart alive.service")
EOF
}

if [[ $# -ne 3 ]]; then
	usage
	exit 2
fi

readonly REPO_DIR="$1"
readonly STATE_DIR="$2"
readonly RESTART_COMMAND="$3"
readonly LOG_DIR="$STATE_DIR/logs"
readonly LOG_FILE="$LOG_DIR/auto-update.log"
readonly HEARTBEAT_FILE="$STATE_DIR/heartbeat.json"

log() {
	local message="$*"
	printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$message" >>"$LOG_FILE"
}

fail() {
	log "ERROR: $*"
	printf 'alive-auto-update: %s\n' "$*" >&2
	exit 1
}

now_ms() {
	"$NODE_BIN" -e 'process.stdout.write(String(Date.now()))'
}

# Epoch milliseconds from heartbeat.json's startedAt, or empty when the file is
# missing, unreadable, or does not carry a valid timestamp.
heartbeat_started_ms() {
	[[ -r "$HEARTBEAT_FILE" ]] || return 1
	"$NODE_BIN" -e '
		const fs = require("node:fs");
		try {
			const heartbeat = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
			const started = Date.parse(heartbeat.startedAt);
			if (Number.isFinite(started)) process.stdout.write(String(started));
		} catch {
			// Missing or half-written heartbeat: the caller keeps polling.
		}
	' "$HEARTBEAT_FILE" 2>/dev/null
}

# Returns 0 as soon as the heartbeat's startedAt is newer than $1.
wait_for_heartbeat_after() {
	local baseline_ms="$1"
	local deadline_ms=$((baseline_ms + RESTART_TIMEOUT_SEC * 1000))
	local started_ms=""
	while :; do
		started_ms="$(heartbeat_started_ms || true)"
		if [[ "$started_ms" =~ ^[0-9]+$ ]] && ((started_ms > baseline_ms)); then
			log "fresh heartbeat observed (startedAt ${started_ms} > baseline ${baseline_ms})"
			return 0
		fi
		if (($(now_ms) >= deadline_ms)); then
			log "no fresh heartbeat within ${RESTART_TIMEOUT_SEC}s (baseline ${baseline_ms})"
			return 1
		fi
		sleep "$POLL_INTERVAL_SEC"
	done
}

run_restart() {
	local status=0
	log "running the restart command"
	set +e
	(cd "$REPO_DIR" && bash -c "$RESTART_COMMAND") >>"$LOG_FILE" 2>&1
	status=$?
	set -e
	if ((status == 0)); then
		log "restart command completed"
	else
		log "restart command failed (exit ${status}); still polling for a heartbeat"
	fi
	return 0
}

mkdir -p "$LOG_DIR"
touch "$LOG_FILE"

[[ -d "$REPO_DIR" ]] || fail "repository directory does not exist: $REPO_DIR"
[[ -n "$RESTART_COMMAND" ]] || fail "restart command is empty"
[[ "$RESTART_TIMEOUT_SEC" =~ ^[0-9]+$ ]] && ((RESTART_TIMEOUT_SEC > 0)) ||
	fail "ALIVE_UPDATE_RESTART_TIMEOUT_SEC must be a positive integer, got: $RESTART_TIMEOUT_SEC"
[[ "$POLL_INTERVAL_SEC" =~ ^[0-9]+$ ]] && ((POLL_INTERVAL_SEC > 0)) ||
	fail "ALIVE_UPDATE_POLL_INTERVAL_SEC must be a positive integer, got: $POLL_INTERVAL_SEC"
command -v "$ALIVE_BIN" >/dev/null 2>&1 || fail "alive executable not found: $ALIVE_BIN (set ALIVE_BIN)"
command -v "$NODE_BIN" >/dev/null 2>&1 || fail "node executable not found: $NODE_BIN (set NODE_BIN)"

log "start: repo=$REPO_DIR state=$STATE_DIR"

# Step 1: the update itself. The exit code is the contract, not stdout.
set +e
(cd "$REPO_DIR" && "$ALIVE_BIN" update --auto) >>"$LOG_FILE" 2>&1
update_status=$?
set -e

case "$update_status" in
0)
	log "no update (alive update --auto exited 0)"
	exit 0
	;;
1)
	log "update failed and was rolled back (alive update --auto exited 1); not restarting"
	exit 1
	;;
10)
	log "update applied (alive update --auto exited 10); restarting the harness"
	;;
*)
	log "unexpected alive update --auto exit code ${update_status}; not restarting"
	exit 1
	;;
esac

# Step 2: restart and wait for proof that a new process actually started.
baseline_ms="$(now_ms)"
log "restart baseline: ${baseline_ms}"
run_restart
if wait_for_heartbeat_after "$baseline_ms"; then
	log "success: the harness restarted with the new build"
	exit 0
fi

# Step 3: the new build did not come up. Roll back and try the old build once.
log "new build did not start; rolling back with alive update --rollback"
set +e
(cd "$REPO_DIR" && "$ALIVE_BIN" update --rollback) >>"$LOG_FILE" 2>&1
rollback_status=$?
set -e
if ((rollback_status != 0)); then
	log "rollback failed (alive update --rollback exited ${rollback_status}); restarting anyway to try to recover"
else
	log "rollback completed (alive update --rollback exited 0)"
fi

baseline_ms="$(now_ms)"
log "second restart baseline: ${baseline_ms}"
run_restart
if wait_for_heartbeat_after "$baseline_ms"; then
	log "recovered: rollback was restarted, but the update itself failed; reporting failure"
	exit 1
fi

log "FATAL: the harness did not come back after rollback and restart"
printf 'alive-auto-update: harness did not come back after rollback; see %s\n' "$LOG_FILE" >&2
exit 1
