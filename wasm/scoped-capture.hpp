#pragma once
#include <lattice/detached_read.hpp>
#include <lattice/log.hpp>
#include <lattice.hpp>

namespace lattice_js_scoped {
inline int version() {
#if !defined(__EMSCRIPTEN__) || defined(__EMSCRIPTEN_PTHREADS__) || defined(__EMSCRIPTEN_SHARED_MEMORY__) || defined(__EMSCRIPTEN_WASM_WORKERS__)
    return 0;
#else
    return 1;
#endif
}
// Suppress possible Module.printErr reentry only in the supported synchronous single-thread
// artifact. JS argument copies and detached-result serialization occur outside this scope.
class native_scope {
    lattice::log_level previous;
public:
    native_scope() : previous(lattice::get_log_level()) {
        if(version()!=1) throw std::runtime_error("Scoped capture requires single-thread Wasm");
        lattice::set_log_level(lattice::log_level::off);
    }
    ~native_scope() noexcept { lattice::set_log_level(previous); }
    native_scope(const native_scope&)=delete;
};
inline lattice::detached_read::result by_ids(const std::shared_ptr<lattice::swift_lattice>& owner,const lattice::detached_read::exact_request& request) {
    native_scope scope;return lattice::detached_read::by_ids(owner,request);
}
inline lattice::detached_read::result by_index(const std::shared_ptr<lattice::swift_lattice>& owner,const lattice::detached_read::indexed_request& request) {
    native_scope scope;return lattice::detached_read::by_indexed_uuid(owner,request);
}
inline lattice::audit_read_fence fence(const std::shared_ptr<lattice::swift_lattice>& owner) {
    native_scope scope;if(!owner||owner->is_closed())throw std::runtime_error("Scoped fence requires an open owner");
    return static_cast<lattice::lattice_db&>(*owner).read_audit_read_fence();
}
} // namespace lattice_js_scoped
