#!/usr/bin/env bash
# Convenience wrapper around the backend's createUser script.
# Usage: scripts/create-admin.sh <username> <password>

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <username> <password>"
  exit 1
fi

USERNAME="$1"
PASSWORD="$2"

docker compose exec backend node dist/scripts/createUser.js "$USERNAME" "$PASSWORD" admin
