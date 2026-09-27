#!/usr/bin/env bash
set -euo pipefail

version=v24.17.0
archive="node-${version}-linux-x64.tar.xz"
base="https://nodejs.org/dist/${version}"
install -d -m 755 /opt/pearlwallet
if [[ ! -x "/opt/pearlwallet/node-${version}/bin/node" ]]; then
  curl --fail --location --silent --show-error "${base}/${archive}" -o "/tmp/${archive}"
  curl --fail --location --silent --show-error "${base}/SHASUMS256.txt" -o /tmp/pearl-node-SHASUMS256.txt
  grep "  ${archive}$" /tmp/pearl-node-SHASUMS256.txt | (cd /tmp && sha256sum --check --status)
  install -d -m 755 "/opt/pearlwallet/node-${version}"
  tar --no-same-owner -xJf "/tmp/${archive}" -C "/opt/pearlwallet/node-${version}" --strip-components=1
fi
"/opt/pearlwallet/node-${version}/bin/node" --version
rm -f "/tmp/${archive}" /tmp/pearl-node-SHASUMS256.txt

if ! id pearlwallet >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/pearlwallet --shell /sbin/nologin pearlwallet
fi
install -d -o pearlwallet -g pearlwallet -m 700 /var/lib/pearlwallet
install -d -m 755 /opt/pearlwallet/current/server
if [[ ! -e /var/lib/pearlwallet/credential-key ]]; then
  umask 077
  openssl rand -base64 32 > /var/lib/pearlwallet/credential-key
  chown pearlwallet:pearlwallet /var/lib/pearlwallet/credential-key
  chmod 600 /var/lib/pearlwallet/credential-key
fi
