#!/bin/sh
set -eu

TURN_CONFIG_PATH="/etc/turnserver/turnserver.conf"
REALM="${TURN_REALM:-charge.local}"
USER_NAME="${TURN_USER:-charge}"
PASSWORD="${TURN_PASSWORD:-}"
CERT_FILE="${TURN_CERT_FILE:-/certs/tls.crt}"
KEY_FILE="${TURN_KEY_FILE:-/certs/tls.key}"
MIN_PORT="${TURN_MIN_PORT:-30000}"
MAX_PORT="${TURN_MAX_PORT:-40000}"
EXTERNAL_IP="${TURN_EXTERNAL_IP:-}"

if [ -z "$PASSWORD" ]; then
  echo "TURN_PASSWORD environment variable is required" >&2
  exit 1
fi

install -d -m 0755 "$(dirname "$TURN_CONFIG_PATH")"
touch "$TURN_CONFIG_PATH"
cat >"$TURN_CONFIG_PATH" <<EOF
lt-cred-mech
no-cli
fingerprint
realm=$REALM
user=$USER_NAME:$PASSWORD
listening-port=3478
tls-listening-port=5349
min-port=$MIN_PORT
max-port=$MAX_PORT
cert=$CERT_FILE
pkey=$KEY_FILE
no-tcp-relay
total-quota=100
bps-capacity=0
EOF

if [ -n "$EXTERNAL_IP" ]; then
  echo "external-ip=$EXTERNAL_IP" >>"$TURN_CONFIG_PATH"
fi

if [ -n "${TURN_EXTRA_FLAGS:-}" ]; then
  printf '%s\n' "$TURN_EXTRA_FLAGS" >>"$TURN_CONFIG_PATH"
fi

echo "Starting TURN server with realm $REALM" >&2
exec turnserver -c "$TURN_CONFIG_PATH" "$@"
