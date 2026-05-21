#!/usr/bin/env bash
# Compile puis ouvre une fenêtre avec l'extension chargée ET le dossier du projet ouvert.
# Usage : depuis la racine du repo :  bash scripts/open-dev-host.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run compile
echo ""
echo "Opening Extension Development Host"
echo "  extensionDevelopmentPath=$ROOT"
echo "  workspace folder=$ROOT"
echo ""
if command -v cursor >/dev/null 2>&1; then
  exec cursor --extensionDevelopmentPath="$ROOT" "$ROOT" "$@"
elif command -v code >/dev/null 2>&1; then
  exec code --extensionDevelopmentPath="$ROOT" "$ROOT" "$@"
else
  echo "Erreur: ni 'cursor' ni 'code' dans le PATH."
  echo "Installe la commande shell depuis l'éditeur (Shell Command: Install ... in PATH)."
  exit 1
fi
