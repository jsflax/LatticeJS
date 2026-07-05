# Distributed under the OSI-approved BSD 3-Clause License.  See accompanying
# file Copyright.txt or https://cmake.org/licensing for details.

cmake_minimum_required(VERSION ${CMAKE_VERSION}) # this file comes with cmake

# If CMAKE_DISABLE_SOURCE_CHANGES is set to true and the source directory is an
# existing directory in our source tree, calling file(MAKE_DIRECTORY) on it
# would cause a fatal error, even though it would be a no-op.
if(NOT EXISTS "/Users/jason/localdev/LatticeJS/wasm/build/_deps/sqlite3-src")
  file(MAKE_DIRECTORY "/Users/jason/localdev/LatticeJS/wasm/build/_deps/sqlite3-src")
endif()
file(MAKE_DIRECTORY
  "/Users/jason/localdev/LatticeJS/wasm/build/_deps/sqlite3-build"
  "/Users/jason/localdev/LatticeJS/wasm/build/_deps/sqlite3-subbuild/sqlite3-populate-prefix"
  "/Users/jason/localdev/LatticeJS/wasm/build/_deps/sqlite3-subbuild/sqlite3-populate-prefix/tmp"
  "/Users/jason/localdev/LatticeJS/wasm/build/_deps/sqlite3-subbuild/sqlite3-populate-prefix/src/sqlite3-populate-stamp"
  "/Users/jason/localdev/LatticeJS/wasm/build/_deps/sqlite3-subbuild/sqlite3-populate-prefix/src"
  "/Users/jason/localdev/LatticeJS/wasm/build/_deps/sqlite3-subbuild/sqlite3-populate-prefix/src/sqlite3-populate-stamp"
)

set(configSubDirs )
foreach(subDir IN LISTS configSubDirs)
    file(MAKE_DIRECTORY "/Users/jason/localdev/LatticeJS/wasm/build/_deps/sqlite3-subbuild/sqlite3-populate-prefix/src/sqlite3-populate-stamp/${subDir}")
endforeach()
if(cfgdir)
  file(MAKE_DIRECTORY "/Users/jason/localdev/LatticeJS/wasm/build/_deps/sqlite3-subbuild/sqlite3-populate-prefix/src/sqlite3-populate-stamp${cfgdir}") # cfgdir has leading slash
endif()
