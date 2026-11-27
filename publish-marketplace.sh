#!/usr/bin/env bash
#
# Build and publish the current version of the extension to the
# Visual Studio Marketplace:
#   https://marketplace.visualstudio.com/items?itemName=shai-dev.shai-vscode
#
# Authentication: a Personal Access Token (Azure DevOps, scope
# "Marketplace > Manage", organization "All accessible organizations")
# for the "shai-dev" publisher, provided via the VSCE_PAT environment variable:
#
#   VSCE_PAT=xxxxx ./publish-marketplace.sh
#
# Options:
#   --skip-tests   do not run `npm test` before packaging
#   --dry-run      build and package the .vsix, but do not upload it
#   --pre-release  publish as a pre-release version
#   -h, --help     show this help
#
set -euo pipefail

cd "$(dirname "$0")"

EXPECTED_ID="shai-dev.shai-vscode"
SKIP_TESTS=0
DRY_RUN=0
PRE_RELEASE=()

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
    case "$arg" in
        --skip-tests) SKIP_TESTS=1 ;;
        --dry-run) DRY_RUN=1 ;;
        --pre-release) PRE_RELEASE=(--pre-release) ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; usage; exit 1 ;;
    esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

command -v node >/dev/null || die "node is not installed."
command -v npm  >/dev/null || die "npm is not installed."

# --- Read identity from package.json ----------------------------------------
PUBLISHER=$(node -p "require('./package.json').publisher")
NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
EXT_ID="${PUBLISHER}.${NAME}"
VSIX="${NAME}-${VERSION}.vsix"

[ "$EXT_ID" = "$EXPECTED_ID" ] || die "package.json identifies '$EXT_ID', expected '$EXPECTED_ID'."
echo "Extension: $EXT_ID"
echo "Version:   $VERSION"

if [ "$DRY_RUN" -eq 0 ] && [ -z "${VSCE_PAT:-}" ]; then
    die "VSCE_PAT is not set. Export a Marketplace Personal Access Token for publisher '$PUBLISHER'."
fi

# --- Dependencies (local vsce from devDependencies) -------------------------
step "Installing dependencies"
if [ -f package-lock.json ]; then npm ci; else npm install; fi
VSCE=(npx --no-install vsce)
"${VSCE[@]}" --version >/dev/null || die "vsce not available (expected @vscode/vsce in devDependencies)."

# --- Refuse to republish an existing version --------------------------------
step "Checking the version currently on the Marketplace"
REMOTE_VERSION=$("${VSCE[@]}" show "$EXT_ID" --json 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log((j.versions&&j.versions[0]&&j.versions[0].version)||'')}catch{console.log('')}})" \
    || true)
if [ -n "$REMOTE_VERSION" ]; then
    echo "Marketplace version: $REMOTE_VERSION"
    NEWER=$(node -e "
        const a='$VERSION'.split('.').map(Number), b='$REMOTE_VERSION'.split('.').map(Number);
        for (let i=0;i<3;i++){ if((a[i]||0)!==(b[i]||0)){ console.log((a[i]||0)>(b[i]||0)?'yes':'no'); process.exit(0);} }
        console.log('no');")
    [ "$NEWER" = "yes" ] || die "Local version $VERSION is not newer than Marketplace version $REMOTE_VERSION. Bump \"version\" in package.json first."
else
    echo "Could not read the Marketplace version (first publish or network issue); continuing."
fi

# --- Build, test, package ---------------------------------------------------
step "Compiling"
npm run compile

if [ "$SKIP_TESTS" -eq 0 ]; then
    step "Running tests"
    npm test
else
    echo "(tests skipped)"
fi

step "Packaging $VSIX"
rm -f "$VSIX"
"${VSCE[@]}" package "${PRE_RELEASE[@]}" --out "$VSIX"
[ -f "$VSIX" ] || die "Packaging did not produce $VSIX."

if [ "$DRY_RUN" -eq 1 ]; then
    echo
    echo "Dry run: $VSIX built, not uploaded."
    exit 0
fi

# --- Publish ----------------------------------------------------------------
step "Publishing $VSIX to the Visual Studio Marketplace"
"${VSCE[@]}" publish "${PRE_RELEASE[@]}" --packagePath "$VSIX" --pat "$VSCE_PAT"

echo
echo "Published $EXT_ID $VERSION"
echo "https://marketplace.visualstudio.com/items?itemName=$EXT_ID"
echo "(The Marketplace may take a few minutes to show the new version.)"
