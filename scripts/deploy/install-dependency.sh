#!/usr/bin/env bash
set -Eeuo pipefail

ACTION="${1:-}"
NON_INTERACTIVE=0
if [[ "${2:-}" == "--non-interactive" ]] || [[ "${DEPLOY_NON_INTERACTIVE:-}" == "1" ]]; then
  NON_INTERACTIVE=1
fi

usage() {
  echo "Usage: install-dependency.sh <node|python|neo4j> [--non-interactive]" >&2
  exit 2
}

case "${ACTION}" in
  node|python|neo4j) ;;
  *) usage ;;
esac

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif [[ "${NON_INTERACTIVE}" -eq 1 ]]; then
    sudo -n "$@"
  else
    sudo "$@"
  fi
}

install_node() {
  local setup
  local nodesource_url="https://deb.nodesource.com/setup_22.x"
  setup="$(mktemp)"
  trap 'rm -f "${setup}"' RETURN
  curl -fsSL "${nodesource_url}" -o "${setup}"
  run_privileged bash "${setup}"
  run_privileged apt-get install -y nodejs
  rm -f "${setup}"
  trap - RETURN
  node --version >/dev/null
  npm --version >/dev/null
}

install_python() {
  run_privileged apt-get update -y
  run_privileged apt-get install -y python3 python3-venv python3-pip
  python3 --version >/dev/null
}

install_neo4j() {
  # Import Neo4j GPG key and add apt repository for Neo4j 5.x.
  run_privileged apt-get update -y
  run_privileged apt-get install -y gnupg curl ca-certificates
  local keyring="/usr/share/keyrings/neo4j-archive-keyring.gpg"
  local repo="deb [signed-by=${keyring}] https://deb.neo4j.com stable latest"
  curl -fsSL "https://deb.neo4j.com/neo4j-archive-key.asc" \
    | run_privileged gpg --dearmor -o "${keyring}"
  echo "${repo}" | run_privileged tee /etc/apt/sources.list.d/neo4j.list >/dev/null
  run_privileged apt-get update -y
  run_privileged apt-get install -y neo4j
  # Enable and start Neo4j service.
  if command -v systemctl >/dev/null 2>&1; then
    run_privileged systemctl enable neo4j
    run_privileged systemctl start neo4j
  fi
  # Wait for bolt port to be ready (up to 30 seconds).
  local i
  for ((i = 0; i < 30; i++)); do
    if curl -sf "http://localhost:7474" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
}

case "${ACTION}" in
  node) install_node ;;
  python) install_python ;;
  neo4j) install_neo4j ;;
esac
