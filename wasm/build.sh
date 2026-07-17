#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"

# Check for Emscripten
if ! command -v emcc &> /dev/null; then
    echo "Error: Emscripten not found. Please install and activate emsdk."
    echo "  git clone https://github.com/emscripten-core/emsdk.git"
    echo "  cd emsdk && ./emsdk install latest && ./emsdk activate latest"
    echo "  source emsdk_env.sh"
    exit 1
fi

# Clean if requested
if [ "$1" == "--clean" ]; then
    echo "Cleaning build directory..."
    rm -rf "$BUILD_DIR"
fi

# Create build directory
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Configure with Emscripten
echo "Configuring with Emscripten..."
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release

# Build
echo "Building WASM module..."
emmake make -j$(nproc 2>/dev/null || sysctl -n hw.ncpu)

# Provenance stamp: which LatticeCore this blob was built from. The wire
# protocol is version-coupled to the server — the rule is: rebuild from the
# latticecore tag matching the server's pinned lattice release, then the
# E2E sync spec (engram-server/app tests/sync.spec.ts) must pass.
LATTICECORE_DIR="${LATTICECORE_DIR:-$SCRIPT_DIR/../LatticeCore}"
# NB: -e not -d — a submodule checkout has a .git *file* pointing at the
# superproject's modules dir.
if [ -e "$LATTICECORE_DIR/.git" ]; then
    CORE_COMMIT=$(git -C "$LATTICECORE_DIR" rev-parse HEAD)
    CORE_TAG=$(git -C "$LATTICECORE_DIR" describe --tags --exact-match 2>/dev/null || echo "")
else
    CORE_COMMIT="unknown"; CORE_TAG=""
fi
cat > "$BUILD_DIR/BUILD_INFO.json" <<INFO
{
  "latticecoreCommit": "$CORE_COMMIT",
  "latticecoreTag": "$CORE_TAG",
  "emsdk": "$(emcc --version | head -1)",
  "date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
INFO

echo ""
echo "Build complete! Output files:"
ls -la "$BUILD_DIR"/lattice.*
cat "$BUILD_DIR/BUILD_INFO.json"
