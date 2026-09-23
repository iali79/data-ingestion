#!/usr/bin/env bash
# Blocks anything that must never appear in this public repository: credentials, tokens,
# connection strings, private keys, secret assignments and routable IP addresses. Runs in CI.
# Patterns are generic on purpose -- this file is public too, so it names nothing specific.
set -euo pipefail
cd "$(dirname "$0")/.."

patterns=(
  'gh[pousr]_[A-Za-z0-9]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'BEGIN [A-Z ]*PRIVATE KEY'
  'AKIA[0-9A-Z]{16}'
  'sk-[A-Za-z0-9_-]{20,}'
  'xox[abpr]-[A-Za-z0-9-]{10,}'
  '[a-z][a-z0-9+.-]*://[^/[:space:]:@]+:[^/[:space:]@]+@'
  '(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp)://'
  '[A-Z0-9_]*(SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9/+_=-]{8,}'
)

# IPv4 addresses other than loopback, unspecified and link-local test values.
ipv4='([0-9]{1,3}\.){3}[0-9]{1,3}'
benign_ip='^(127\.0\.0\.1|0\.0\.0\.0|169\.254\.169\.254)$'

files=$(git ls-files 2>/dev/null || find . -type f -not -path './node_modules/*' -not -path './dist/*' -not -path './.git/*')
hits=0
for file in $files; do
  case "$file" in
    scripts/secret-scan.sh|package-lock.json) continue ;;
    .env|.env.*|*.pem|*.key|*.p12|*.pfx) echo "secret-scan: forbidden file $file"; hits=$((hits + 1)); continue ;;
  esac
  for pattern in "${patterns[@]}"; do
    if grep -nEIq -- "$pattern" "$file"; then
      echo "secret-scan: $file matches a credential pattern"
      hits=$((hits + 1))
    fi
  done
  # A generated dependency lock holds four-part version numbers ("opencv-python==5.0.0.93").
  if [ "$file" != python/requirements.lock ] && grep -oEI -- "$ipv4" "$file" 2>/dev/null | grep -vEq "$benign_ip"; then
    echo "secret-scan: $file contains an IP address"
    hits=$((hits + 1))
  fi
done

if [ "$hits" -gt 0 ]; then
  echo "secret-scan: $hits finding(s) -- refusing."
  exit 1
fi
echo "secret-scan: clean"
