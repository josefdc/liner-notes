#!/bin/sh
# Starts Caddy (the web image's command). The Caddyfile reads /etc/caddy/site.d/*.caddy, the
# deployment's deploy/site.d mounted read-only; a directory this user cannot read matches no file
# there, which Caddy only warns about, and a certificate named in it would be silently replaced by
# one Caddy asks a certificate authority for. So an unreadable site.d, or file in it, stops here.
set -eu

dir=/etc/caddy/site.d
if [ -e "$dir" ]; then
  if [ ! -r "$dir" ] || [ ! -x "$dir" ]; then
    echo "$dir cannot be read by uid $(id -u): make deploy/site.d 755 (README, \"Certificates\")" >&2
    exit 1
  fi
  for file in "$dir"/*; do
    [ -e "$file" ] || continue
    if [ ! -r "$file" ]; then
      echo "$file cannot be read by uid $(id -u): make it 644, or for a key owned by uid $(id -u) 600 (README, \"Certificates\")" >&2
      exit 1
    fi
  done
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
