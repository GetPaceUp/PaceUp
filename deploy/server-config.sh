#!/usr/bin/env bash
# Applies the server settings kept in this repo, so changing them needs no SSH:
#   deploy/caddy/Caddyfile  -> /etc/caddy/Caddyfile   (web server: domains, redirects)
#   deploy/public-url       -> APP_BASE_URL and WEB_ORIGIN in /etc/paceup.env (the address in every link we send)
# auto-deploy.sh runs it as root every minute; when nothing differs it does nothing.
# Safety: the Caddyfile must validate, must keep every name the current one serves, and the live
# address must still answer afterwards, or the previous file goes back. The link address only
# changes once https://<new address>/health answers through real DNS with a real certificate,
# so no message ever carries a link that does not open yet. Each result goes to the Super Admin on WhatsApp.
set -uo pipefail

APP="${APP:-/opt/paceup}"
RUN_AS="${RUN_AS-runuser -u amit --}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
CADDY="${CADDY:-caddy}"
CADDY_SRC="${CADDY_SRC:-$APP/deploy/caddy/Caddyfile}"
CADDY_DST="${CADDY_DST:-/etc/caddy/Caddyfile}"
URL_SRC="${URL_SRC:-$APP/deploy/public-url}"
ENV_FILE="${ENV_FILE:-/etc/paceup.env}"
STATE_DIR="${STATE_DIR:-/var/lib/paceup}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/health}"
SETTLE="${SETTLE:-3}"

log() { echo "[paceup-config] $*"; }
run() { if [ -n "$RUN_AS" ]; then $RUN_AS "$@"; else "$@"; fi; }
notify() { (cd "$APP" && run node deploy/notify.cjs "$1") || log "could not queue the WhatsApp note: $1"; }
stamp() { date -u +%Y%m%dT%H%M%SZ; }
sum12() { sha256sum "$1" | cut -c1-12; }

base_url() { sed -n 's/^APP_BASE_URL=//p' "$ENV_FILE" 2>/dev/null | tail -n1 | tr -d "\"' " | sed 's#/*$##'; }
host_of() { echo "$1" | sed -E 's#^https?://##; s#[/:].*##'; }
# Every site name a Caddyfile serves, one per line, sorted.
caddy_hosts() {
  "$CADDY" adapt --config "$1" --adapter caddyfile 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const out = new Set(); const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object")
        for (const [k, v] of Object.entries(o)) { if (k === "host" && Array.isArray(v)) v.forEach((h) => out.add(h)); else walk(v); } };
      try { walk(JSON.parse(s)); } catch {} console.log([...out].sort().join("\n"));
    });'
}
# The live address answers through this VM: /health is ok and a page route returns the app.
# -L follows a redirect to another name through real DNS.
site_ok() {
  local host="$1"
  curl -fsSL --max-time 15 --resolve "$host:443:127.0.0.1" "https://$host/health" 2>/dev/null | grep -q '"ok"' &&
    curl -fsSL --max-time 15 --resolve "$host:443:127.0.0.1" "https://$host/r/config-check" 2>/dev/null | grep -q 'id="root"'
}
api_ok() { local i; for i in $(seq 1 20); do curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null | grep -q '"ok"' && return 0; sleep 2; done; return 1; }

sync_caddy() {
  [ -f "$CADDY_SRC" ] && [ -f "$CADDY_DST" ] || return 0
  cmp -s "$CADDY_SRC" "$CADDY_DST" && return 0
  local sum failed live backup missing
  sum=$(sum12 "$CADDY_SRC"); failed="$STATE_DIR/config-failed-caddy-$sum"
  [ -e "$failed" ] && return 0   # this version already failed once; wait for a newer one
  give_up() { touch "$failed"; log "caddy $sum: $1"; notify "⚠️ PaceUp: new web server settings ($sum) not applied: $1. The site keeps running on the previous settings."; }

  "$CADDY" validate --config "$CADDY_SRC" --adapter caddyfile >/dev/null 2>&1 || { give_up "they did not validate"; return 0; }
  missing=$(comm -23 <(caddy_hosts "$CADDY_DST") <(caddy_hosts "$CADDY_SRC") | tr '\n' ' ')
  [ -n "${missing// /}" ] && { give_up "they would stop serving ${missing% }"; return 0; }
  live=$(host_of "$(base_url)")
  [ -n "$live" ] || { give_up "APP_BASE_URL is missing from $ENV_FILE"; return 0; }

  backup="$CADDY_DST.bak-$(stamp)"
  cp -p "$CADDY_DST" "$backup" || { give_up "could not back up the current file"; return 0; }
  cat "$CADDY_SRC" > "$CADDY_DST"
  if "$SYSTEMCTL" reload caddy && sleep "$SETTLE" && site_ok "$live"; then
    log "caddy $sum applied (backup $backup)"
    notify "✅ PaceUp: web server settings $sum applied. $live checked and working."
    return 0
  fi
  cat "$backup" > "$CADDY_DST"; "$SYSTEMCTL" reload caddy
  give_up "$live stopped answering with them, so I put the previous settings back"
}

sync_public_url() {
  [ -f "$URL_SRC" ] && [ -f "$ENV_FILE" ] || return 0
  local want have sum failed backup tmp
  want=$(head -n1 "$URL_SRC" | tr -d '[:space:]' | sed 's#/*$##')
  [[ "$want" =~ ^https://[a-z0-9.-]+$ ]] || { log "ignoring public-url: $want"; return 0; }
  have=$(base_url)
  [ "$want" = "$have" ] && return 0
  sum=$(echo "$want" | sha256sum | cut -c1-12); failed="$STATE_DIR/config-failed-url-$sum"
  [ -e "$failed" ] && return 0
  # Wait (silently, retried every minute) until the new address really works from the internet.
  curl -fsS --max-time 10 "$want/health" 2>/dev/null | grep -q '"ok"' || { log "waiting for $want to answer before switching links"; return 0; }

  backup="$ENV_FILE.bak-$(stamp)"; cp -p "$ENV_FILE" "$backup" || return 0
  tmp=$(mktemp)
  awk -v u="$want" 'BEGIN{a=0;w=0} /^APP_BASE_URL=/{print "APP_BASE_URL=" u; a=1; next} /^WEB_ORIGIN=/{print "WEB_ORIGIN=" u; w=1; next} {print}
    END{if(!a) print "APP_BASE_URL=" u; if(!w) print "WEB_ORIGIN=" u}' "$ENV_FILE" > "$tmp" && cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  if "$SYSTEMCTL" restart paceup-api && sleep "$SETTLE" && "$SYSTEMCTL" restart paceup-whatsapp && api_ok; then
    log "links now use $want (was $have; backup $backup)"
    notify "✅ PaceUp: links in posts, invites, codes and nudges now use $want."
    return 0
  fi
  cat "$backup" > "$ENV_FILE"; "$SYSTEMCTL" restart paceup-api; sleep "$SETTLE"; "$SYSTEMCTL" restart paceup-whatsapp
  touch "$failed"
  notify "⚠️ PaceUp: switching links to $want failed the health check, so links stay on $have."
}

sync_caddy
sync_public_url
exit 0
