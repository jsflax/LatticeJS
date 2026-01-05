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

echo ""
echo "Build complete! Output files:"
ls -la "$BUILD_DIR"/lattice.*
