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
        -sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','addFunction','UTF8ToString','HEAPU8','FS']
        -sEXPORTED_FUNCTIONS=['_malloc','_free','_ws_handle_open','_ws_handle_message','_ws_handle_error','_ws_handle_close','_lattice_set_log_level']
        -sMODULARIZE=1
        -sEXPORT_ES6=1
        -sEXPORT_NAME=createLatticeModule
        -sENVIRONMENT=web,worker
        -sINVOKE_RUN=0
        -sFORCE_FILESYSTEM=1
        # Link our custom OPFS VFS JS library
        --js-library=${CMAKE_SOURCE_DIR}/opfs_vfs_lib.js
        -sALLOW_TABLE_GROWTH=1
    )

endif()

# Fetch SQLite amalgamation (3.45.0) instead of Emscripten's bundled 3.39.0
# Required for unhex() function (added in 3.41.0), used by sync BLOB handling
include(FetchContent)
FetchContent_Declare(
    sqlite3
    URL https://www.sqlite.org/2024/sqlite-amalgamation-3450000.zip
)
FetchContent_MakeAvailable(sqlite3)

add_library(sqlite3_bundled STATIC ${sqlite3_SOURCE_DIR}/sqlite3.c)
target_include_directories(sqlite3_bundled PUBLIC ${sqlite3_SOURCE_DIR})
target_compile_definitions(sqlite3_bundled PRIVATE
    SQLITE_ENABLE_FTS5
    SQLITE_ENABLE_JSON1
)
target_compile_definitions(sqlite3_bundled PUBLIC SQLITE_CORE)

# Path to LatticeCore. Resolution order:
#   1. LATTICECORE_DIR env var        (their dev-loop override)
#   2. -DLATTICE_CPP_DIR cache var    (explicit cmake override)
#   3. the tag-pinned LatticeCore submodule at the repo root (default —
#      reproducible everywhere, incl. CI)
if(DEFINED ENV{LATTICECORE_DIR} AND NOT "$ENV{LATTICECORE_DIR}" STREQUAL "")
    set(LATTICE_CPP_DIR "$ENV{LATTICECORE_DIR}")
else()
    set(LATTICE_CPP_DIR "${CMAKE_SOURCE_DIR}/../LatticeCore" CACHE PATH "LatticeCore checkout to build against")
endif()

# Include directories (include the bridge!)
include_directories(
    ${LATTICE_CPP_DIR}/Sources/LatticeCore/include
    ${LATTICE_CPP_DIR}/Sources/LatticeSwiftCppBridge/include
    ${LATTICE_CPP_DIR}/Sources/LatticeCAPI/include
    ${LATTICE_CPP_DIR}/Sources/SqliteVec/src
    ${LATTICE_CPP_DIR}/Sources/SqliteVec/include
)

# Collect LatticeCore sources
file(GLOB_RECURSE LATTICE_CPP_SOURCES
    ${LATTICE_CPP_DIR}/Sources/LatticeCore/src/*.cpp
)

# Bridge sources
file(GLOB_RECURSE BRIDGE_SOURCES
    ${LATTICE_CPP_DIR}/Sources/LatticeSwiftCppBridge/src/*.cpp
)

# C API sources
file(GLOB_RECURSE CAPI_SOURCES
    ${LATTICE_CPP_DIR}/Sources/LatticeCAPI/src/*.cpp
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
    ${CAPI_SOURCES}
    ${SQLITE_VEC_SOURCES}
    ${BINDINGS_SOURCES}
)

# SqliteVec: Disable SIMD optimizations for WASM and use static linking
target_compile_definitions(lattice PRIVATE
    # No SQLITE_VEC_ENABLE_NEON
    # No SQLITE_VEC_ENABLE_AVX
    SQLITE_CORE=1
)

# Link bundled SQLite
target_link_libraries(lattice PRIVATE sqlite3_bundled)
target_include_directories(lattice PRIVATE ${sqlite3_SOURCE_DIR})

# WASM-specific defines
if(EMSCRIPTEN)
    target_compile_definitions(lattice PRIVATE
        LATTICE_WASM=1
        LATTICE_OPFS_VFS=1
    )
endif()
