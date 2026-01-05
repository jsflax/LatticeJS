cmake_minimum_required(VERSION 3.16)
project(LatticeJS)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Emscripten-specific settings
if(EMSCRIPTEN)
    set(CMAKE_EXECUTABLE_SUFFIX ".js")

    # Emscripten compile flags
    add_compile_options(
        -fexceptions
    )

    # Emscripten link flags
    add_link_options(
        -lembind
        -fexceptions
        -sALLOW_MEMORY_GROWTH=1
        -sMAXIMUM_MEMORY=512MB
        -sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','addFunction','UTF8ToString','HEAPU8']
        -sEXPORTED_FUNCTIONS=['_malloc','_free','_ws_handle_open','_ws_handle_message','_ws_handle_error','_ws_handle_close']
        -sMODULARIZE=1
        -sEXPORT_ES6=1
        -sEXPORT_NAME=createLatticeModule
        -sENVIRONMENT=web,worker
        -sUSE_SQLITE3=1
        -sINVOKE_RUN=0
        -sFORCE_FILESYSTEM=1
        # Link our custom OPFS VFS JS library
        --js-library=${CMAKE_SOURCE_DIR}/opfs_vfs_lib.js
        -sALLOW_TABLE_GROWTH=1
    )

    # Use Emscripten's SQLite port
    add_compile_options(-sUSE_SQLITE3=1)
endif()

# Path to LatticeCpp
set(LATTICE_CPP_DIR "${CMAKE_SOURCE_DIR}/../../LatticeCpp")

# Include directories (include the bridge!)
include_directories(
    ${LATTICE_CPP_DIR}/Sources/LatticeCpp/include
    ${LATTICE_CPP_DIR}/Sources/LatticeSwiftCppBridge/include
    ${LATTICE_CPP_DIR}/Sources/SqliteVec/src
    ${LATTICE_CPP_DIR}/Sources/SqliteVec/include
)

# Collect LatticeCpp sources
file(GLOB_RECURSE LATTICE_CPP_SOURCES
    ${LATTICE_CPP_DIR}/Sources/LatticeCpp/src/*.cpp
)

# Bridge sources
file(GLOB_RECURSE BRIDGE_SOURCES
    ${LATTICE_CPP_DIR}/Sources/LatticeSwiftCppBridge/src/*.cpp
)

# SqliteVec (without SIMD for WASM)
set(SQLITE_VEC_SOURCES
    ${LATTICE_CPP_DIR}/Sources/SqliteVec/src/sqlite-vec.c
)

# Our Embind bindings + OPFS VFS
set(BINDINGS_SOURCES
    ${CMAKE_SOURCE_DIR}/bindings.cpp
    ${CMAKE_SOURCE_DIR}/opfs_vfs.cpp
)

# Create the WASM module
add_executable(lattice
    ${LATTICE_CPP_SOURCES}
    ${BRIDGE_SOURCES}
    ${SQLITE_VEC_SOURCES}
    ${BINDINGS_SOURCES}
)

# SqliteVec: Disable SIMD optimizations for WASM and use static linking
target_compile_definitions(lattice PRIVATE
    # No SQLITE_VEC_ENABLE_NEON
    # No SQLITE_VEC_ENABLE_AVX
    SQLITE_CORE=1
)

# WASM-specific defines
if(EMSCRIPTEN)
    target_compile_definitions(lattice PRIVATE
        LATTICE_WASM=1
        LATTICE_OPFS_VFS=1
    )
endif()
