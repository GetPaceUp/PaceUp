#!/usr/bin/env bash
# Tests deploy/server-config.sh with fake caddy, systemctl and curl. Run: bash deploy/test-server-config.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/app/deploy" "$T/state"
fails=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; fails=$((fails + 1)); fi; }

# Fake caddy: "validate" fails when the file contains BROKEN; "adapt" lists site names as JSON hosts.
cat > "$T/bin/caddy" <<'EOF'
#!/usr/bin/env bash
f="$3"
case "$1" in
  validate) ! grep -q BROKEN "$f" ;;
  adapt) hosts=$(grep -E '^[a-z0-9].*\{$' "$f" | sed 's/ *{$//; s/, */\n/g' | sed 's/.*/"&"/' | paste -sd,); echo "{\"apps\":{\"http\":{\"servers\":{\"s\":{\"routes\":[{\"match\":[{\"host\":[$hosts]}]}]}}}}}" ;;
esac
EOF
# Fake systemctl: records calls.
printf '#!/usr/bin/env bash\necho "$*" >> "%s/systemctl.log"\n' "$T" > "$T/bin/systemctl"
# Fake curl: the site answers unless $T/site-down exists; a public URL answers only if $T/public-up exists.
cat > "$T/bin/curl" <<EOF
#!/usr/bin/env bash
url="\${@: -1}"
case "\$url" in
  http://127.0.0.1*) echo '{"status":"ok"}' ;;
  */health) if [[ "\$*" == *--resolve* ]]; then [ -e "$T/site-down" ] && exit 22; echo '{"status":"ok"}'; else [ -e "$T/public-up" ] || exit 6; echo '{"status":"ok"}'; fi ;;
  *) [ -e "$T/site-down" ] && exit 22; echo '<div id="root"></div>' ;;
esac
EOF
# Fake notify (the real one writes to the database).
printf 'require("fs").appendFileSync(process.env.NOTES, process.argv[2] + "\\n");\n' > "$T/app/deploy/notify.cjs"
chmod +x "$T/bin/"*

export PATH="$T/bin:$PATH" APP="$T/app" RUN_AS="" STATE_DIR="$T/state" SETTLE=0 NOTES="$T/notes"
export CADDY_SRC="$T/app/deploy/caddy/Caddyfile" CADDY_DST="$T/etc-Caddyfile" URL_SRC="$T/app/deploy/public-url" ENV_FILE="$T/paceup.env"
mkdir -p "$T/app/deploy/caddy"
OLD='paceup.feetandpedals.com {
	reverse_proxy 127.0.0.1:3001
}
paceup.folksonforks.com {
	redir https://paceup.feetandpedals.com{uri} permanent
}'
reset() { rm -f "$T"/state/* "$T/site-down" "$T/public-up" "$T/notes" "$T/systemctl.log" "$URL_SRC" "$T"/etc-Caddyfile.bak-* "$T"/paceup.env.bak-*
  echo "$OLD" > "$CADDY_DST"; printf 'PORT=3001\nAPP_BASE_URL=https://paceup.feetandpedals.com\nWEB_ORIGIN=https://paceup.feetandpedals.com\nAPP_SECRET=x\n' > "$ENV_FILE"; }
cfg() { bash "$HERE/server-config.sh"; }

reset; cp "$HERE/caddy/Caddyfile" "$CADDY_SRC"; cfg
check "repo Caddyfile is installed" 'cmp -s "$CADDY_SRC" "$CADDY_DST"'
check "Caddy reloaded once" '[ "$(cat "$T/systemctl.log")" = "reload caddy" ]'
check "old file backed up" 'ls "$T"/etc-Caddyfile.bak-* >/dev/null 2>&1'
check "success note sent" 'grep -q "✅ PaceUp: web server settings" "$T/notes"'
: > "$T/systemctl.log"; cfg
check "second run changes nothing" '[ ! -s "$T/systemctl.log" ]'

reset; echo "BROKEN" >> "$CADDY_SRC"; cfg
check "invalid file is not installed" 'grep -q "^paceup.feetandpedals.com {" "$CADDY_DST" && ! grep -q getpaceup "$CADDY_DST"'
check "invalid file reported" 'grep -q "did not validate" "$T/notes"'
rm "$T/notes"; cfg
check "a failed version is not retried every minute" '[ ! -e "$T/notes" ]'

reset; printf 'getpaceup.com {\n\trespond ok\n}\n' > "$CADDY_SRC"; cfg
check "file that drops a served name is refused" '! grep -q "^getpaceup.com" "$CADDY_DST" && grep -q "stop serving paceup.feetandpedals.com paceup.folksonforks.com" "$T/notes"'

reset; cp "$HERE/caddy/Caddyfile" "$CADDY_SRC"; touch "$T/site-down"; cfg
check "site down after reload -> previous file restored" '[ "$(cat "$CADDY_DST")" = "$OLD" ]'
check "restore reloads Caddy again" '[ "$(grep -c "reload caddy" "$T/systemctl.log")" = 2 ]'
check "restore reported" 'grep -q "put the previous settings back" "$T/notes"'

reset; cp "$HERE/caddy/Caddyfile" "$CADDY_SRC"; echo "https://getpaceup.com" > "$URL_SRC"; cfg
check "links wait while the new address does not answer" 'grep -q "^APP_BASE_URL=https://paceup.feetandpedals.com$" "$ENV_FILE"'
touch "$T/public-up"; cfg
check "links switch once it answers" 'grep -q "^APP_BASE_URL=https://getpaceup.com$" "$ENV_FILE" && grep -q "^WEB_ORIGIN=https://getpaceup.com$" "$ENV_FILE"'
check "other settings kept" 'grep -q "^APP_SECRET=x$" "$ENV_FILE" && [ "$(grep -c APP_BASE_URL "$ENV_FILE")" = 1 ]'
check "API and worker restarted" 'grep -q "restart paceup-api" "$T/systemctl.log" && grep -q "restart paceup-whatsapp" "$T/systemctl.log"'
check "switch reported" 'grep -q "now use https://getpaceup.com" "$T/notes"'
: > "$T/systemctl.log"; cfg
check "no restart when already switched" '[ ! -s "$T/systemctl.log" ]'

reset; echo "http://evil.example/x y" > "$URL_SRC"; touch "$T/public-up"; cfg
check "a malformed address is ignored" 'grep -q "^APP_BASE_URL=https://paceup.feetandpedals.com$" "$ENV_FILE"'

[ "$fails" = 0 ] && echo "all server-config tests passed" || { echo "$fails failed"; exit 1; }
