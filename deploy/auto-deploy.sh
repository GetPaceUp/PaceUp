#!/usr/bin/env bash
# Self-deploy for the PaceUp VM. A systemd timer runs this every minute. When main on GitHub has a
# new commit it: backs up the database, fast-forwards /opt/paceup, builds, restarts the services,
# checks /health, and rolls the code back if the check fails. Either way it WhatsApps the Super Admin
# the result from the club number. Merging a PR to main IS the deploy approval.
#
# Pause:   sudo touch /etc/paceup-deploy-paused      Resume: sudo rm /etc/paceup-deploy-paused
# Log:     journalctl -u paceup-deploy -n 100
# Note: the whole script lives in main() so bash has read it all before git replaces the file.
set -uo pipefail

APP="${APP:-/opt/paceup}"
RUN_AS="${RUN_AS-runuser -u amit --}"        # git/npm run as the app user (tests set RUN_AS="")
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/health}"
STATE_DIR="${STATE_DIR:-/var/lib/paceup}"
PAUSE_FILE="${PAUSE_FILE:-/etc/paceup-deploy-paused}"
LOCK_FILE="${LOCK_FILE:-/run/paceup-deploy.lock}"
HEALTH_TRIES="${HEALTH_TRIES:-20}"

log() { echo "[paceup-deploy] $*"; }
run() { if [ -n "$RUN_AS" ]; then $RUN_AS "$@"; else "$@"; fi; }
notify() { (cd "$APP" && run node deploy/notify.cjs "$1") || log "could not queue the WhatsApp note: $1"; }
healthy() { for _ in $(seq 1 "$HEALTH_TRIES"); do curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null | grep -q '"ok"' && return 0; sleep 2; done; return 1; }
restart_all() { "$SYSTEMCTL" restart paceup-api && sleep 3 && "$SYSTEMCTL" restart paceup-whatsapp; }
build() { # $1 = old sha, $2 = new sha (npm ci only when the lockfile changed)
  if [ -n "$(cd "$APP" && run git diff --name-only "$1" "$2" -- package-lock.json)" ]; then (cd "$APP" && run npm ci) || return 1; fi
  (cd "$APP" && run npm run build) || return 1
}

main() {
  exec 9>"$LOCK_FILE"; flock -n 9 || exit 0
  [ -e "$PAUSE_FILE" ] && exit 0
  cd "$APP" || exit 0
  run git fetch -q origin main || { log "fetch failed, will retry"; exit 0; }
  local cur new short failed_file
  cur=$(run git rev-parse HEAD); new=$(run git rev-parse origin/main)
  [ "$cur" = "$new" ] && exit 0
  short=${new:0:7}; failed_file="$STATE_DIR/deploy-last-failed-sha"
  [ -f "$failed_file" ] && [ "$(cat "$failed_file")" = "$new" ] && exit 0   # already failed once; wait for a newer commit
  if ! run git merge-base --is-ancestor "$cur" "$new"; then
    echo "$new" > "$failed_file"; notify "⚠️ PaceUp: main ($short) is not a straight update of what is live, so I did not deploy it."; exit 0
  fi
  log "deploying $cur -> $new"

  local backup
  backup=$(run node deploy/backup-db.cjs) || { echo "$new" > "$failed_file"; notify "⚠️ PaceUp: could not back up the database, so I did not deploy $short. Nothing changed."; exit 0; }
  log "backup: $backup"

  if run git merge --ff-only "$new" >/dev/null && build "$cur" "$new" && restart_all && healthy; then
    rm -f "$failed_file"
    notify "✅ PaceUp updated to $short. Health check passed. Backup: $(basename "$backup")"
    log "deployed $short"; exit 0
  fi

  log "deploy of $short failed, rolling the code back to ${cur:0:7}"
  run git reset -q --hard "$cur"
  build "$new" "$cur"; restart_all
  echo "$new" > "$failed_file"
  if healthy; then
    notify "⚠️ PaceUp: update $short failed its health check. I rolled the code back and the site is running the previous version. Database backup: $(basename "$backup")"
  else
    notify "🚨 PaceUp: update $short failed and the rollback did not pass the health check either. The site may be down. Database backup: $(basename "$backup")"
  fi
  exit 0
}
main "$@"
exit 0
