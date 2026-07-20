#!/bin/sh
# Generate a self-signed TLS certificate for AlertCanvas.
#
#   ./tools/gen-cert.sh [hostname-or-ip ...]
#
# Examples:
#   ./tools/gen-cert.sh                          # localhost only
#   ./tools/gen-cert.sh 192.168.1.50 nas.lan     # reachable names/IPs
#
# Writes server.crt + server.key into <data dir>/certs/, where <data dir> is
# whatever host directory you mount at /data in the container - ./data by
# default, or set CERT_DIR when you've pointed the volume elsewhere:
#
#   CERT_DIR=/srv/noc-data/certs ./tools/gen-cert.sh 192.168.1.50
#
# The server detects the pair on start and switches to HTTPS automatically -
# restart the container after running this. Browsers will warn about the
# self-signed cert once per browser; to use a real certificate instead, just
# place your own PEM cert/key at <data dir>/certs/server.crt + server.key.
set -e

DIR="${CERT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/data/certs}"
mkdir -p "$DIR"

CN="${1:-localhost}"
SAN="DNS:localhost,IP:127.0.0.1"
for h in "$@"; do
    case "$h" in
        *[!0-9.]*) SAN="$SAN,DNS:$h" ;;   # anything non-numeric is a DNS name
        *)         SAN="$SAN,IP:$h" ;;
    esac
done

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$DIR/server.key" -out "$DIR/server.crt" \
    -subj "/CN=$CN" -addext "subjectAltName=$SAN"
chmod 600 "$DIR/server.key"

# The container runs as the "node" user (uid 1000); it must be able to read
# the key. Best-effort - rerun with sudo if this warns.
chown -R 1000:1000 "$DIR" 2>/dev/null || \
    echo "NOTE: could not chown $DIR to uid 1000 - run: sudo chown -R 1000:1000 $DIR"

echo ""
echo "Wrote $DIR/server.crt and server.key (valid 10 years, SAN: $SAN)."
echo "Restart AlertCanvas (docker compose restart) to enable HTTPS."
