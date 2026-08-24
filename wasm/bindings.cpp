#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <emscripten.h>
#include <sqlite3.h>
#include <unordered_set>

// WASMFS is only available when WASMFS=1 is set
#ifdef __EMSCRIPTEN_WASM_WORKERS__
// This is actually checked via WASMFS define
#endif

#include <lattice.hpp>
#include <lattice/scheduler.hpp>
#include <dynamic_object.hpp>
#include <list.hpp>
#include <lattice/sync.hpp>

#include <sys/stat.h>

using namespace emscripten;
using namespace lattice;

// Debug logging that works in SharedWorker by posting to BroadcastChannel
EM_JS(void, debugLogToChannel, (const char* msg), {
    // Post to the debug BroadcastChannel so main thread can see it
    if (typeof BroadcastChannel !== 'undefined') {
        try {
            var channel = new BroadcastChannel('lattice-debug');
            channel.postMessage({ type: 'log', msg: '[C++] ' + UTF8ToString(msg) });
            channel.close();
        } catch (e) {}
    }
    // Also log to console (will appear in SharedWorker's own console)
    console.log('[C++]', UTF8ToString(msg));
});

// ============================================================================
// Emscripten Scheduler - dispatches callbacks via the browser event loop
// ============================================================================
// This is critical for WASM - we need to dispatch observer callbacks through
// the Emscripten event loop rather than calling them directly, to ensure
// proper integration with JavaScript's single-threaded execution model.

class emscripten_scheduler : public scheduler {
public:
    void invoke(std::function<void()>&& fn) override {
        if (!fn) {
            return;
        }

        // Allocate the callback on the heap so it survives until async dispatch
        auto* callback = new std::function<void()>(std::move(fn));

        // Use emscripten_async_call to dispatch to the event loop
        // The delay of 0 means "as soon as possible" in the next event loop tick
        emscripten_async_call([](void* arg) {
            auto* cb = static_cast<std::function<void()>*>(arg);
            try {
                if (*cb) (*cb)();
            } catch (const std::exception& e) {
                char buf[512];
                snprintf(buf, sizeof(buf), "SCHEDULER EXCEPTION: %s", e.what());
                debugLogToChannel(buf);
            } catch (...) {
                debugLogToChannel("SCHEDULER EXCEPTION: unknown");
            }
            delete cb;
        }, callback, 0);
    }

    [[nodiscard]] bool is_on_thread() const noexcept override {
        return true;  // WASM is single-threaded
    }

    [[nodiscard]] bool is_same_as(const scheduler* other) const noexcept override {
        return dynamic_cast<const emscripten_scheduler*>(other) != nullptr;
    }

    [[nodiscard]] bool can_invoke() const noexcept override {
        return true;
    }
};

// Global scheduler instance for WASM
static std::shared_ptr<emscripten_scheduler> g_emscripten_scheduler = std::make_shared<emscripten_scheduler>();

// ============================================================================
// Browser WebSocket Client - wraps JS WebSocket for C++ sync
// ============================================================================

#include <lattice/network.hpp>

class emscripten_websocket_client : public sync_transport {
private:
    val ws_ = val::null();
    transport_state state_ = transport_state::closed;

    on_open_handler on_open_;
    on_message_handler on_message_;
    on_error_handler on_error_;
    on_close_handler on_close_;

public:
    emscripten_websocket_client() = default;
    ~emscripten_websocket_client() override {
        disconnect();
    }

    void connect(const std::string& url,
                 const std::map<std::string, std::string>& headers = {}) override {
        if (!ws_.isNull()) {
            disconnect();
        }

        state_ = transport_state::connecting;

        // Browser WebSocket doesn't support custom headers
        // Pass Authorization token as query parameter instead
        std::string final_url = url;
        auto auth_it = headers.find("Authorization");
        if (auth_it != headers.end()) {
            std::string token = auth_it->second;
            // Strip "Bearer " prefix if present
            if (token.rfind("Bearer ", 0) == 0) {
                token = token.substr(7);
            }
            // URL-encode the token via JS encodeURIComponent
            val encodeURI = val::global("encodeURIComponent");
            std::string encoded = encodeURI(val(token)).as<std::string>();
            // Append as query param
            if (final_url.find('?') != std::string::npos) {
                final_url += "&token=" + encoded;
            } else {
                final_url += "?token=" + encoded;
            }
        }

        // Create WebSocket
        val WebSocket = val::global("WebSocket");
        ws_ = WebSocket.new_(final_url);

        // Set binary type to arraybuffer
        ws_.set("binaryType", val("arraybuffer"));

        // Store reference to this client for callbacks BEFORE adding handlers
        ws_.set("_lattice_client", val(reinterpret_cast<uintptr_t>(this)));

        // Use addEventListener instead of property assignment for reliable
        // message delivery in SharedWorker context
        ws_.call<void>("addEventListener", val("open"), val::module_property("_ws_onopen_handler"));
        ws_.call<void>("addEventListener", val("message"), val::module_property("_ws_onmessage_handler"));
        ws_.call<void>("addEventListener", val("error"), val::module_property("_ws_onerror_handler"));
        ws_.call<void>("addEventListener", val("close"), val::module_property("_ws_onclose_handler"));

    }

    void disconnect() override {
        if (!ws_.isNull()) {
            // Detach BEFORE close(), in this order, or teardown dispatches
            // into freed memory: the browser delivers ws events as later
            // tasks, and this object can be destroyed (db.delete() → dtor →
            // disconnect) before they run. removeEventListener prevents even
            // already-queued event tasks from invoking the handlers, clearing
            // _lattice_client covers any path that still reads it, and the
            // message-queue purge drops deferred frames that captured the raw
            // pointer at enqueue time. Side effect, deliberate: an
            // intentional disconnect emits NO syncstate events — only
            // server-initiated closes (e.g. the projector's kick) reach
            // app-level reconnect logic.
            val purge = val::module_property("_ws_purge_client");
            if (!purge.isUndefined()) {
                purge(val(reinterpret_cast<uintptr_t>(this)));
            }
            ws_.set("_lattice_client", val(0));
            ws_.call<void>("removeEventListener", val("open"), val::module_property("_ws_onopen_handler"));
            ws_.call<void>("removeEventListener", val("message"), val::module_property("_ws_onmessage_handler"));
            ws_.call<void>("removeEventListener", val("error"), val::module_property("_ws_onerror_handler"));
            ws_.call<void>("removeEventListener", val("close"), val::module_property("_ws_onclose_handler"));
            ws_.call<void>("close");
            ws_ = val::null();
        }
        state_ = transport_state::closed;
    }

    transport_state state() const override {
        return state_;
    }

    void send(const transport_message& message) override {
        if (ws_.isNull() || state_ != transport_state::open) {
            return;
        }

        // Convert to ArrayBuffer and send using HEAPU8 for fast bulk copy
        val Uint8Array = val::global("Uint8Array");
        val buffer = Uint8Array.new_(val(message.data.size()));

        // Bulk copy via HEAPU8 subarray — avoids per-byte JS↔C++ interop
        val heapu8 = val::module_property("HEAPU8");
        auto ptr = reinterpret_cast<uintptr_t>(message.data.data());
        buffer.call<void>("set", heapu8.call<val>("subarray", val(ptr), val(ptr + message.data.size())));

        ws_.call<void>("send", buffer);
    }

    void set_on_open(on_open_handler handler) override { on_open_ = handler; }
    void set_on_message(on_message_handler handler) override { on_message_ = handler; }
    void set_on_error(on_error_handler handler) override { on_error_ = handler; }
    void set_on_close(on_close_handler handler) override { on_close_ = handler; }

    // Called from JS handlers
    void handle_open() {
        state_ = transport_state::open;
        if (on_open_) {
            g_emscripten_scheduler->invoke([this]() {
                on_open_();
            });
        }
    }

    void handle_message(val event) {
        val data = event["data"];

        transport_message msg;

        if (data.instanceof(val::global("ArrayBuffer"))) {
            // Binary message — bulk copy via HEAPU8 for performance
            val Uint8Array = val::global("Uint8Array");
            val arr = Uint8Array.new_(data);
            size_t len = arr["length"].as<size_t>();

            msg.msg_type = transport_message::type::binary;
            msg.data.resize(len);

            // Use HEAPU8 + malloc for bulk copy instead of per-byte interop
            auto* dest = msg.data.data();
            val malloc_fn = val::module_property("_malloc");
            val free_fn = val::module_property("_free");
            uintptr_t tmp = malloc_fn(val((unsigned)len)).as<uintptr_t>();
            // Re-read HEAPU8 after malloc — malloc may grow WASM memory,
            // which detaches any prior typed array views of the heap
            val heapu8 = val::module_property("HEAPU8");
            // Copy JS ArrayBuffer into WASM heap
            heapu8.call<val>("subarray", val(tmp), val(tmp + len)).call<void>("set", arr);
            // Copy from WASM heap to our vector
            std::memcpy(dest, reinterpret_cast<void*>(tmp), len);
            free_fn(val(tmp));

        } else {
            // Text message
            std::string text = data.as<std::string>();
            msg.msg_type = transport_message::type::text;
            msg.data = std::vector<uint8_t>(text.begin(), text.end());
        }

        if (on_message_) {
            g_emscripten_scheduler->invoke([this, msg = std::move(msg)]() { on_message_(msg); });
        }
    }

    void handle_error(val event) {
        debugLogToChannel("WS error occurred");
        if (on_error_) {
            g_emscripten_scheduler->invoke([this]() { on_error_("WebSocket error"); });
        }
    }

    void handle_close(val event) {
        int code = event["code"].as<int>();
        std::string reason = event["reason"].as<std::string>();
        {
            char buf[256];
            snprintf(buf, sizeof(buf), "WS closed: code=%d reason=%s", code, reason.c_str());
            debugLogToChannel(buf);
        }

        state_ = transport_state::closed;
        ws_ = val::null();

        if (on_close_) {
            g_emscripten_scheduler->invoke([this, code, reason]() { on_close_(code, reason); });
        }
    }
};

// Global map of active WebSocket clients for callback dispatch
static std::map<uintptr_t, emscripten_websocket_client*> g_ws_clients;

// JavaScript callback handlers - these are called from the WebSocket events
EM_JS(void, setup_ws_handlers, (), {
    // Debug helper: post to BroadcastChannel from JS
    function jsDebugLog(msg) {
        try {
            var ch = new BroadcastChannel('lattice-debug');
            ch.postMessage({ type: 'log', msg: '[C++ JS] ' + msg });
            ch.close();
        } catch(e) {}
        console.log('[C++ JS]', msg);
    }
    // Sync-state observation (Lattice.onSyncState). MULTI-listener: the SPA
    // registers from both main.ts (banner) and sidebar.ts (pill), and the
    // embed's reconnect controller adds a third — last-wins would silently
    // kill all but one. null clears all. Payload matches types.ts
    // SyncStateInfo. Callbacks must never throw into the ws handler.
    Module._syncStateCbs = [];
    Module.setSyncStateCallback = function(cb) {
        if (cb === null) { Module._syncStateCbs = []; return; }
        Module._syncStateCbs.push(cb);
    };
    Module._dispatchSyncState = function(state, code, reason) {
        var cbs = Module._syncStateCbs;
        for (var i = 0; i < cbs.length; i++) {
            try { cbs[i]({ state: state, code: code, reason: reason }); }
            catch (e) { console.warn('[lattice] syncState callback failed', e); }
        }
    };
    // Drop deferred frames whose client is being destroyed — they captured
    // the raw pointer at enqueue time and would dispatch into freed memory.
    Module._ws_purge_client = function(clientPtr) {
        if (Module._ws_msg_queue) {
            Module._ws_msg_queue = Module._ws_msg_queue.filter(function(item) {
                return item.client !== clientPtr;
            });
        }
    };
    Module._ws_onopen_handler = function(event) {
        jsDebugLog('onopen fired, client=' + this._lattice_client);
        var client = this._lattice_client;
        if (client) {
            Module._ws_handle_open(client);
        }
        Module._dispatchSyncState('open', 0, '');
    };
    // Message queue — yields to browser between chunks so the UI stays responsive
    // during large catch-up syncs.
    Module._ws_msg_queue = [];
    Module._ws_draining = false;
    Module._ws_drain = function() {
        if (Module._ws_msg_queue.length === 0) {
            Module._ws_draining = false;
            return;
        }
        var item = Module._ws_msg_queue.shift();
        Module._ws_pending_event = item.event;
        Module._ws_handle_message(item.client);
        Module._ws_pending_event = null;
        setTimeout(Module._ws_drain, 0);
    };
    Module._ws_onmessage_handler = function(event) {
        var dataType = event.data instanceof ArrayBuffer ? 'binary' : 'text';
        var dataLen = event.data instanceof ArrayBuffer ? event.data.byteLength : (typeof event.data === 'string' ? event.data.length : '?');
        jsDebugLog('onmessage fired: type=' + dataType + ' len=' + dataLen + ' client=' + this._lattice_client);
        var client = this._lattice_client;
        if (client) {
            Module._ws_msg_queue.push({ client: client, event: event });
            if (!Module._ws_draining) {
                Module._ws_draining = true;
                setTimeout(Module._ws_drain, 0);
            }
        } else {
            jsDebugLog('WARNING: onmessage but no _lattice_client!');
        }
    };
    Module._ws_onerror_handler = function(event) {
        jsDebugLog('onerror fired, client=' + this._lattice_client);
        var client = this._lattice_client;
        if (client) {
            Module._ws_pending_event = event;
            Module._ws_handle_error(client);
            Module._ws_pending_event = null;
        }
        Module._dispatchSyncState('error', 0, '');
    };
    Module._ws_onclose_handler = function(event) {
        jsDebugLog('onclose fired: code=' + event.code + ' reason=' + event.reason + ' client=' + this._lattice_client);
        var client = this._lattice_client;
        if (client) {
            Module._ws_pending_event = event;
            Module._ws_handle_close(client);
            Module._ws_pending_event = null;
        }
        Module._dispatchSyncState('closed', event.code, event.reason || '');
    };
});

extern "C" {
    EMSCRIPTEN_KEEPALIVE void ws_handle_open(uintptr_t client_ptr) {
        auto* client = reinterpret_cast<emscripten_websocket_client*>(client_ptr);
        if (client) client->handle_open();
    }

    EMSCRIPTEN_KEEPALIVE void ws_handle_message(uintptr_t client_ptr) {
        auto* client = reinterpret_cast<emscripten_websocket_client*>(client_ptr);
        if (client) {
            val event = val::module_property("_ws_pending_event");
            client->handle_message(event);
        }
    }

    EMSCRIPTEN_KEEPALIVE void ws_handle_error(uintptr_t client_ptr) {
        auto* client = reinterpret_cast<emscripten_websocket_client*>(client_ptr);
        if (client) {
            val event = val::module_property("_ws_pending_event");
            client->handle_error(event);
        }
    }

    EMSCRIPTEN_KEEPALIVE void ws_handle_close(uintptr_t client_ptr) {
        auto* client = reinterpret_cast<emscripten_websocket_client*>(client_ptr);
        if (client) {
            val event = val::module_property("_ws_pending_event");
            client->handle_close(event);
        }
    }
}

// Network factory for browser environment
class emscripten_network_factory : public network_factory {
public:
    std::unique_ptr<http_client> create_http_client() override {
        // HTTP client not implemented yet - would use fetch()
        return std::make_unique<null_http_client>();
    }

    std::unique_ptr<sync_transport> create_sync_transport() override {
        return std::make_unique<emscripten_websocket_client>();
    }
};

// Initialize the network factory
static bool g_network_factory_initialized = false;

void init_emscripten_network() {
    if (!g_network_factory_initialized) {
        setup_ws_handlers();
        auto factory = std::make_shared<emscripten_network_factory>();
        set_network_factory(factory);
        g_network_factory_initialized = true;
    }
}

// ============================================================================
// OPFS VFS Initialization (custom VFS using browser OPFS API)
// ============================================================================

#include <atomic>

static std::atomic<bool> opfs_initialized{false};
static std::atomic<bool> opfs_init_failed{false};

#if defined(__EMSCRIPTEN__) && defined(LATTICE_OPFS_VFS)
// Custom OPFS VFS - defined in opfs_vfs.cpp
extern "C" {
    int opfs_vfs_register(int makeDefault);
    int opfs_vfs_available();
}

// Initialize OPFS VFS (synchronous, no pthreads needed)
bool initOPFSSync() {
    debugLogToChannel("initOPFSSync called");
    if (opfs_initialized.load()) {
        debugLogToChannel("Already initialized");
        return true;
    }

    debugLogToChannel("Initializing custom OPFS VFS...");
    printf("[OPFS] Initializing custom OPFS VFS...\n");

    debugLogToChannel("Checking opfs_vfs_available...");
    if (!opfs_vfs_available()) {
        debugLogToChannel("OPFS not available in this context");
        printf("[OPFS] OPFS not available in this context (not a Worker?)\n");
        opfs_init_failed.store(true);
        return false;
    }
    debugLogToChannel("OPFS is available, registering VFS...");

    // Register OPFS as the default VFS
    // Note: :memory: databases are handled specially by SQLite and don't use VFS for main file
    int rc = opfs_vfs_register(1);  // Make OPFS the default VFS
    char buf[64];
    snprintf(buf, sizeof(buf), "opfs_vfs_register returned: %d", rc);
    debugLogToChannel(buf);
    if (rc != 0) {
        debugLogToChannel("VFS registration failed!");
        printf("[OPFS] Failed to register OPFS VFS: %d\n", rc);
        opfs_init_failed.store(true);
        return false;
    }

    debugLogToChannel("VFS registered successfully as default");
    printf("[OPFS] OPFS VFS registered successfully\n");
    opfs_initialized.store(true);
    return true;
}

// Async init just calls sync init (no pthreads needed anymore)
bool initOPFSAsync() {
    return initOPFSSync();
}

// Check if OPFS is available
bool isOPFSAvailable() {
    return opfs_initialized.load();
}

#else
// OPFS VFS not enabled
bool initOPFSAsync() {
    printf("[OPFS] OPFS VFS not enabled in build\n");
    return false;
}

bool initOPFSSync() {
    printf("[OPFS] OPFS VFS not enabled in build\n");
    return false;
}

bool isOPFSAvailable() {
    return false;
}
#endif

// Check if OPFS initialization is still in progress (always false now - sync init)
bool isOPFSInitInProgress() {
    return false;
}

// Check if OPFS initialization failed
bool isOPFSInitFailed() {
    return opfs_init_failed.load();
}

// Forward declarations
class JsLinkList;

// ============================================================================
// DynamicObjectRef wrapper for Embind
// ============================================================================

class JsDynamicObject {
public:
    JsDynamicObject() : ref_(nullptr) {}

    explicit JsDynamicObject(dynamic_object_ref* ref) : ref_(ref) {
        if (ref_) retainDynamicObjectRef(ref_);
    }

    ~JsDynamicObject() {
        if (ref_) releaseDynamicObjectRef(ref_);
    }

    JsDynamicObject(const JsDynamicObject& other) : ref_(other.ref_) {
        if (ref_) retainDynamicObjectRef(ref_);
    }

    JsDynamicObject& operator=(const JsDynamicObject& other) {
        if (this != &other) {
            if (ref_) releaseDynamicObjectRef(ref_);
            ref_ = other.ref_;
            if (ref_) retainDynamicObjectRef(ref_);
        }
        return *this;
    }

    bool isValid() const { return ref_ != nullptr; }

    // Getters
    int64_t getInt(const std::string& name) const {
        return ref_ ? ref_->get_int(name) : 0;
    }

    std::string getString(const std::string& name) const {
        return ref_ ? ref_->get_string(name) : "";
    }

    double getDouble(const std::string& name) const {
        return ref_ ? ref_->get_double(name) : 0.0;
    }

    bool getBool(const std::string& name) const {
        return ref_ ? ref_->get_bool(name) : false;
    }

    bool hasValue(const std::string& name) const {
        return ref_ ? ref_->has_value(name) : false;
    }

    // Setters
    void setInt(const std::string& name, int64_t value) {
        if (ref_) ref_->set_int(name, value);
    }

    void setString(const std::string& name, const std::string& value) {
        if (ref_) ref_->set_string(name, value);
    }

    void setDouble(const std::string& name, double value) {
        if (ref_) ref_->set_double(name, value);
    }

    void setBool(const std::string& name, bool value) {
        if (ref_) ref_->set_bool(name, value);
    }

    void setNil(const std::string& name) {
        if (ref_) ref_->set_nil(name);
    }

    // Link handling - the key methods!
    JsDynamicObject getObject(const std::string& name) const {
        if (!ref_) return JsDynamicObject();
        auto* linked = ref_->get_object(name);
        if (!linked) return JsDynamicObject();
        retainDynamicObjectRef(linked);
        return JsDynamicObject(linked);
    }

    void setObject(const std::string& name, JsDynamicObject& value) {
        if (ref_ && value.ref_) {
            ref_->set_object(name, *value.ref_);
        }
    }

    // Get a link list property - forward declaration, implemented after JsLinkList
    JsLinkList getLinkList(const std::string& name) const;

    dynamic_object_ref* raw() { return ref_; }

private:
    dynamic_object_ref* ref_;
};

// ============================================================================
// JsLinkList - wrapper for link_list_ref
// ============================================================================

class JsLinkList {
public:
    JsLinkList() : ref_(nullptr), owned_(false) {}

    // Take ownership of a link_list_ref* returned from get_link_list()
    // get_link_list() returns a new pointer with ref_count=0, we retain it
    explicit JsLinkList(link_list_ref* ref) : ref_(ref), owned_(true) {
        if (ref_) {
            retainLinkListRef(ref_);
        }
    }

    ~JsLinkList() {
        if (ref_ && owned_) {
            releaseLinkListRef(ref_);
        }
    }

    // Copy constructor - share the ref
    JsLinkList(const JsLinkList& other) : ref_(other.ref_), owned_(true) {
        if (ref_) {
            retainLinkListRef(ref_);
        }
    }

    // Move constructor - transfer ownership
    JsLinkList(JsLinkList&& other) noexcept : ref_(other.ref_), owned_(other.owned_) {
        other.ref_ = nullptr;
        other.owned_ = false;
    }

    JsLinkList& operator=(const JsLinkList& other) {
        if (this != &other) {
            if (ref_ && owned_) releaseLinkListRef(ref_);
            ref_ = other.ref_;
            owned_ = true;
            if (ref_) retainLinkListRef(ref_);
        }
        return *this;
    }

    JsLinkList& operator=(JsLinkList&& other) noexcept {
        if (this != &other) {
            if (ref_ && owned_) releaseLinkListRef(ref_);
            ref_ = other.ref_;
            owned_ = other.owned_;
            other.ref_ = nullptr;
            other.owned_ = false;
        }
        return *this;
    }

    bool isValid() const { return ref_ != nullptr; }

    size_t size() const {
        return ref_ ? ref_->size() : 0;
    }

    bool empty() const {
        return ref_ ? ref_->empty() : true;
    }

    // Get element at index as JsDynamicObject
    JsDynamicObject at(size_t idx) const {
        if (!ref_ || idx >= ref_->size()) return JsDynamicObject();
        auto proxy = (*ref_)[idx];
        if (!proxy.object) return JsDynamicObject();
        auto* obj_ref = dynamic_object_ref::wrap(proxy.object);
        retainDynamicObjectRef(obj_ref);
        return JsDynamicObject(obj_ref);
    }

    void push_back(JsDynamicObject& obj) {
        if (ref_ && obj.raw()) {
            ref_->push_back(*obj.raw());
        }
    }

    // Remove element at index
    void erase(size_t idx) {
        if (ref_ && idx < ref_->size()) {
            ref_->erase(idx);
        }
    }

    // Clear all elements
    void clear() {
        if (ref_) ref_->clear();
    }

    link_list_ref* raw() { return ref_; }

private:
    link_list_ref* ref_;
    bool owned_;
};

// Implement JsDynamicObject::getLinkList now that JsLinkList is defined
JsLinkList JsDynamicObject::getLinkList(const std::string& name) const {
    if (!ref_) return JsLinkList();
    auto* list_ref = ref_->get_link_list(name);
    if (!list_ref) return JsLinkList();
    return JsLinkList(list_ref);
}

// ============================================================================
// Helper: Convert JS object to property_descriptor
// ============================================================================

property_descriptor js_to_property_descriptor(const val& prop) {
    property_descriptor desc;
    desc.name = prop["name"].as<std::string>();

    std::string type_str = prop["type"].as<std::string>();
    if (type_str == "string") desc.type = column_type::text;
    else if (type_str == "int" || type_str == "integer") desc.type = column_type::integer;
    else if (type_str == "float" || type_str == "double" || type_str == "real") desc.type = column_type::real;
    else if (type_str == "date") desc.type = column_type::real;  // Dates stored as Unix timestamps
    else if (type_str == "bool" || type_str == "boolean") desc.type = column_type::integer;
    else if (type_str == "blob" || type_str == "data") desc.type = column_type::blob;
    else desc.type = column_type::text;

    std::string kind_str = prop["kind"].isUndefined() ? "primitive" : prop["kind"].as<std::string>();
    if (kind_str == "link") desc.kind = property_kind::link;
    else if (kind_str == "list") desc.kind = property_kind::list;
    else desc.kind = property_kind::primitive;

    desc.target_table = prop["targetTable"].isUndefined() ? "" : prop["targetTable"].as<std::string>();
    desc.nullable = prop["nullable"].isUndefined() ? true : prop["nullable"].as<bool>();
    desc.is_vector = prop["isVector"].isUndefined() ? false : prop["isVector"].as<bool>();
    desc.is_full_text = prop["isFullText"].isUndefined() ? false : prop["isFullText"].as<bool>();
    desc.is_indexed = prop["isIndexed"].isUndefined() ? false : prop["isIndexed"].as<bool>();

    return desc;
}

// ============================================================================
// Helper: Convert JS schema array to SchemaVector
// ============================================================================

SchemaVector js_to_schema_vector(const val& schemas) {
    SchemaVector result;

    auto length = schemas["length"].as<size_t>();
    for (size_t i = 0; i < length; i++) {
        val schema = schemas[i];
        swift_schema_entry entry;
        entry.table_name = schema["tableName"].as<std::string>();

        val props = schema["properties"];
        auto props_length = props["length"].as<size_t>();
        for (size_t j = 0; j < props_length; j++) {
            auto desc = js_to_property_descriptor(props[j]);
            entry.properties[desc.name] = desc;
        }

        // Read constraints (unique constraints)
        if (!schema["constraints"].isUndefined()) {
            val constraints = schema["constraints"];
            auto constraints_length = constraints["length"].as<size_t>();
            for (size_t k = 0; k < constraints_length; k++) {
                val c = constraints[k];
                swift_constraint constraint;
                val cols = c["columns"];
                auto cols_length = cols["length"].as<size_t>();
                for (size_t l = 0; l < cols_length; l++) {
                    constraint.columns.push_back(cols[l].as<std::string>());
                }
                constraint.allows_upsert = c["allowsUpsert"].isUndefined() ? false : c["allowsUpsert"].as<bool>();
                entry.constraints.push_back(constraint);
            }
        }

        result.push_back(entry);
    }

    return result;
}

// ============================================================================
// Helper: Convert JS object values to dynamic_object
// ============================================================================

void js_to_dynamic_object(dynamic_object_ref* obj, const val& js_obj,
                          const SwiftSchema* schema, lattice::swift_lattice* db) {
    // Note: table_name should already be set by dynamic_object_ref::create(table_name)

    val keys = val::global("Object").call<val>("keys", js_obj);
    auto length = keys["length"].as<size_t>();

    for (size_t i = 0; i < length; i++) {
        std::string key = keys[i].as<std::string>();
        val value = js_obj[key];

        if (value.isNull() || value.isUndefined()) {
            obj->set_nil(key);
            continue;
        }

        // Check if this is a link property
        if (schema && db) {
            auto it = schema->find(key);
            if (it != schema->end() && it->second.kind == property_kind::link) {
                // This is a link property - we need to look up the linked object
                if (value.isNumber()) {
                    int64_t linked_id = static_cast<int64_t>(value.as<double>());
                    auto linked_obj = db->object(linked_id, it->second.target_table);
                    if (linked_obj) {
                        dynamic_object_ref linked_ref(*linked_obj);
                        obj->set_object(key, linked_ref);
                    } else {
                        obj->set_nil(key);
                    }
                } else {
                    obj->set_nil(key);
                }
                continue;
            }
        }

        // Regular (non-link) properties
        if (value.isNumber()) {
            // Check if it's an integer or float
            double d = value.as<double>();
            if (d == static_cast<int64_t>(d)) {
                obj->set_int(key, static_cast<int64_t>(d));
            } else {
                obj->set_double(key, d);
            }
        } else if (value.isString()) {
            obj->set_string(key, value.as<std::string>());
        } else if (value.typeOf().as<std::string>() == "boolean") {
            obj->set_bool(key, value.as<bool>());
        }
        // TODO: Handle arrays, Uint8Array for blobs
    }
}

// ============================================================================
// Helper: Convert dynamic_object to JS object
// ============================================================================

// Forward declaration for recursive calls
val dynamic_object_ref_to_js(dynamic_object_ref* obj, const SwiftSchema* schema);

val dynamic_object_to_js(dynamic_object_ref* obj, const SwiftSchema* schema) {
    val result = val::object();

    if (!schema) return result;

    for (const auto& [name, prop] : *schema) {
        // Handle link properties - use getObject to get the actual linked object
        if (prop.kind == property_kind::link) {
            if (!obj->has_value(name)) {
                result.set(name, val::null());
            } else {
                // Get the linked object directly using C++ mechanism
                try {
                    auto* linked_ref = obj->get_object(name);
                    if (!linked_ref) {
                        // Fallback: return the ID
                        result.set(name, obj->get_int(name));
                    } else {
                        int64_t linked_id = linked_ref->get_int("id");
                        if (linked_id == 0) {
                            result.set(name, val::null());
                            releaseDynamicObjectRef(linked_ref);
                        } else {
                            // Convert the linked object to JS
                            auto* linked_schema = linked_ref->getLattice()->get()->get_properties_for_table(prop.target_table);
                            val linked_js = dynamic_object_ref_to_js(linked_ref, linked_schema);
                            linked_js.set("id", linked_id);
                            linked_js.set("globalId", linked_ref->get_string("globalId"));
                            result.set(name, linked_js);
                            releaseDynamicObjectRef(linked_ref);
                        }
                    }
                } catch (const std::exception& e) {
                    // Fallback to returning the ID if getObject fails
                    printf("getObject failed for %s: %s\n", name.c_str(), e.what());
                    result.set(name, obj->get_int(name));
                } catch (...) {
                    printf("getObject failed for %s: unknown error\n", name.c_str());
                    result.set(name, obj->get_int(name));
                }
            }
            continue;
        }

        // Skip list properties for now - they're in junction tables
        if (prop.kind == property_kind::list) {
            continue;
        }

        if (!obj->has_value(name)) {
            result.set(name, val::null());
            continue;
        }

        switch (prop.type) {
            case column_type::integer:
                result.set(name, obj->get_int(name));
                break;
            case column_type::real:
                result.set(name, obj->get_double(name));
                break;
            case column_type::text:
                result.set(name, obj->get_string(name));
                break;
            case column_type::blob: {
                auto data = obj->get_data(name);
                // Convert to Uint8Array
                val uint8_array = val::global("Uint8Array").new_(data.size());
                for (size_t i = 0; i < data.size(); i++) {
                    uint8_array.set(i, data[i]);
                }
                result.set(name, uint8_array);
                break;
            }
            default:
                break;
        }
    }

    return result;
}

// Version that handles nested links (calls dynamic_object_to_js for recursion)
val dynamic_object_ref_to_js(dynamic_object_ref* obj, const SwiftSchema* schema) {
    // Just delegate to the main function which handles everything
    return dynamic_object_to_js(obj, schema);
}

// ============================================================================
// JS Wrapper for swift_lattice
// ============================================================================

// Helper to throw JS Error from C++ exception
void throw_js_error(const std::string& msg) {
    val error = val::global("Error").new_(msg);
    throw error;
}

class JsLattice {
    /// True only for the read-only audit constructor, which retains the ref
    /// it creates; releaseStorage() releases exactly that reference.
    bool owns_reference_ = false;

public:
    // Constructor without sync
    JsLattice(const std::string& path, const val& schemas)
        : JsLattice(path, schemas, "", "") {}

    // Arity-3: READ-ONLY AUDIT OPEN (readOnlyAudit must be true; `schemas` is
    // ignored — the schema is reconstructed from the file). Built for the
    // orphaned-write drain (src/pending-drain.ts): reading an ABANDONED
    // store's AuditLog must not mutate it, and the write-capable constructor
    // does — ensure_tables + heal_collapsed_sync_state run before any read,
    // and a schema drift would MIGRATE the file. `create_dynamic` opens
    // read-only (no DDL, no change hook, no sync socket), bypasses the
    // key-cache (ptr-registered only, so it can never alias a later writable
    // open of the same path), and holds the ONLY shared_ptr — releaseStorage()
    // really closes the connection. A missing file throws (SQLITE_CANTOPEN),
    // which is the point: a missing store is an error the caller can tell
    // apart from an empty one.
    JsLattice(const std::string& path, const val& /*schemas*/, bool read_only_audit) {
        if (!read_only_audit) {
            throw_js_error("arity-3 Lattice constructor is the read-only audit open; pass true");
        }
        try {
            swift_configuration config;
            config.path = path;
            config.sched = g_emscripten_scheduler;
            ref_ = swift_lattice_ref::create_dynamic(config);
            // _make() constructs with ref_count_ 0 and nothing here ever
            // retained — so release() underflowed 0→-1, returned false, and
            // the wrapper (with the ONLY shared_ptr) leaked: the exact
            // refcount no-op the drain review flagged. Take the reference
            // this handle actually owns; releaseStorage() drops it to zero
            // and the connection really closes.
            retainSwiftLatticeRef(ref_);
            owns_reference_ = true;
        } catch (const std::exception& e) {
            throw_js_error(std::string("Failed to open database read-only: ") + e.what());
        } catch (...) {
            throw_js_error("Failed to open database read-only: unknown error");
        }
    }

    // Constructor with sync configuration
    JsLattice(const std::string& path, const val& schemas,
              const std::string& websocket_url, const std::string& auth_token) {
        try {
            if (!websocket_url.empty()) {
                init_emscripten_network();
            }

            configuration config(path, g_emscripten_scheduler);

            if (!websocket_url.empty()) {
                config.websocket_url = websocket_url;
                config.authorization_token = auth_token;
            }

            auto schema_vec = js_to_schema_vector(schemas);
            ref_ = swift_lattice_ref::create(config, schema_vec);
        } catch (const std::exception& e) {
            throw_js_error(std::string("Failed to open database: ") + e.what());
        } catch (...) {
            throw_js_error("Failed to open database: unknown error");
        }
    }

    // Constructor with migration support
    JsLattice(const std::string& path, const val& schemas,
              const std::string& websocket_url, const std::string& auth_token,
              int32_t schema_version, val migration_callback) {
        try {
            if (!websocket_url.empty()) {
                init_emscripten_network();
            }

            configuration config(path, g_emscripten_scheduler);
            config.target_schema_version = schema_version;

            if (!websocket_url.empty()) {
                config.websocket_url = websocket_url;
                config.authorization_token = auth_token;
            }

            auto schema_vec = js_to_schema_vector(schemas);

            if (!migration_callback.isNull() && !migration_callback.isUndefined()) {
                // Use create_with_migration
                auto* stored_callback = new val(migration_callback);
                swift_migration_block_t block = [stored_callback](swift_migration_context_ref* ctx) {
                    // Convert swift_migration_context_ref to JS object
                    val js_ctx = val::object();

                    // pendingChanges()
                    auto changes = ctx->pending_changes();
                    val js_changes = val::array();
                    for (const auto& tc : changes) {
                        val change = val::object();
                        change.set("tableName", val(tc.table_name));
                        val added = val::array();
                        for (const auto& c : tc.added_columns) added.call<void>("push", val(c));
                        change.set("addedColumns", added);
                        val removed = val::array();
                        for (const auto& c : tc.removed_columns) removed.call<void>("push", val(c));
                        change.set("removedColumns", removed);
                        val changed = val::array();
                        for (const auto& c : tc.changed_columns) changed.call<void>("push", val(c));
                        change.set("changedColumns", changed);
                        js_changes.call<void>("push", change);
                    }
                    js_ctx.set("pendingChanges", js_changes);

                    // hasChangesFor(tableName)
                    js_ctx.set("hasChangesFor", val::module_property("_migration_has_changes_for"));

                    // renameProperty(tableName, old, new)
                    js_ctx.set("_ctx_ptr", val(reinterpret_cast<uintptr_t>(ctx)));
                    js_ctx.set("renameProperty", val::module_property("_migration_rename_property"));
                    js_ctx.set("deleteAll", val::module_property("_migration_delete_all"));
                    js_ctx.set("executeSql", val::module_property("_migration_execute_sql"));

                    (*stored_callback)(js_ctx);
                };
                ref_ = swift_lattice_ref::create_with_migration(config, schema_vec, block);
                delete stored_callback;
            } else {
                ref_ = swift_lattice_ref::create(config, schema_vec);
            }
        } catch (const std::exception& e) {
            throw_js_error(std::string("Failed to open database with migration: ") + e.what());
        }
    }

    ~JsLattice() {
        if (ref_) {
            releaseSwiftLatticeRef(ref_);
        }
    }

    // Add an object to a table, returns the new object's ID
    int64_t add(const std::string& table_name, const val& js_obj) {
        try {
            // Get the schema for this table from the database
            auto* schema = ref_->get()->get_properties_for_table(table_name);
            if (!schema) {
                throw_js_error("Unknown table: " + table_name);
                return -1;
            }

            // Create swift_dynamic_object with table name AND properties (like Swift does)
            swift_dynamic_object unmanaged_obj(table_name, *schema);

            // Wrap in dynamic_object_ref using constructor from swift_dynamic_object
            auto* obj_ref = new dynamic_object_ref(unmanaged_obj);
            retainDynamicObjectRef(obj_ref);

            // Pass schema and lattice so links can be resolved properly
            js_to_dynamic_object(obj_ref, js_obj, schema, ref_->get());

            ref_->get()->add(*obj_ref->get());

            int64_t id = obj_ref->get_int("id");
            releaseDynamicObjectRef(obj_ref);
            return id;
        } catch (const std::exception& e) {
            throw_js_error(std::string("add failed: ") + e.what());
        } catch (...) {
            throw_js_error("add failed: unknown error");
        }
        return -1;
    }

    // Find object by primary key
    val find(const std::string& table_name, int64_t id) {
        try {
            auto result = ref_->get()->object(id, table_name);
            if (!result) {
                return val::null();
            }

            auto* obj_ref = new dynamic_object_ref(*result);
            auto* schema = ref_->get()->get_properties_for_table(table_name);
            val js_obj = dynamic_object_to_js(obj_ref, schema);
            js_obj.set("id", result->id());
            js_obj.set("globalId", result->global_id());
            delete obj_ref;
            return js_obj;
        } catch (const std::exception& e) {
            throw_js_error(std::string("find failed: ") + e.what());
        } catch (...) {
            throw_js_error("find failed: unknown error");
        }
        return val::null();
    }

    // Find object by global ID
    val findByGlobalId(const std::string& table_name, const std::string& global_id) {
        try {
            auto result = ref_->get()->object_by_global_id(global_id, table_name);
            if (!result) {
                return val::null();
            }

            auto* obj_ref = new dynamic_object_ref(*result);
            auto* schema = ref_->get()->get_properties_for_table(table_name);
            val js_obj = dynamic_object_to_js(obj_ref, schema);
            js_obj.set("id", result->id());
            js_obj.set("globalId", result->global_id());
            delete obj_ref;
            return js_obj;
        } catch (const std::exception& e) {
            throw_js_error(std::string("findByGlobalId failed: ") + e.what());
        } catch (...) {
            throw_js_error("findByGlobalId failed: unknown error");
        }
        return val::null();
    }

    // Query objects from a table
    val objects(const std::string& table_name,
                const val& where_clause,
                const val& order_by,
                const val& limit,
                const val& offset,
                const val& group_by,
                const val& distinct_by) {
        try {
            OptionalString where = where_clause.isNull() || where_clause.isUndefined()
                ? std::nullopt : std::optional<std::string>(where_clause.as<std::string>());
            OptionalString order = order_by.isNull() || order_by.isUndefined()
                ? std::nullopt : std::optional<std::string>(order_by.as<std::string>());
            OptionalInt64 lim = limit.isNull() || limit.isUndefined()
                ? std::nullopt : std::optional<int64_t>(limit.as<int64_t>());
            OptionalInt64 off = offset.isNull() || offset.isUndefined()
                ? std::nullopt : std::optional<int64_t>(offset.as<int64_t>());
            OptionalString group = group_by.isNull() || group_by.isUndefined()
                ? std::nullopt : std::optional<std::string>(group_by.as<std::string>());
            OptionalString distinct_ = distinct_by.isNull() || distinct_by.isUndefined()
                ? std::nullopt : std::optional<std::string>(distinct_by.as<std::string>());

            auto results = ref_->get()->objects(table_name, where, order, lim, off, group, distinct_);
            auto* schema = ref_->get()->get_properties_for_table(table_name);

            val arr = val::array();
            for (size_t i = 0; i < results.size(); i++) {
                auto* obj_ref = new dynamic_object_ref(results[i]);
                val js_obj = dynamic_object_to_js(obj_ref, schema);
                js_obj.set("id", results[i].id());
                js_obj.set("globalId", results[i].global_id());
                arr.call<void>("push", js_obj);
                delete obj_ref;
            }
            return arr;
        } catch (const std::exception& e) {
            throw_js_error(std::string("objects query failed: ") + e.what());
        } catch (...) {
            throw_js_error("objects query failed: unknown error");
        }
        return val::array();
    }

    // Count objects in a table
    size_t count(const std::string& table_name, const val& where_clause,
                 const val& group_by, const val& distinct_by) {
        try {
            OptionalString where = where_clause.isNull() || where_clause.isUndefined()
                ? std::nullopt : std::optional<std::string>(where_clause.as<std::string>());
            OptionalString group = group_by.isNull() || group_by.isUndefined()
                ? std::nullopt : std::optional<std::string>(group_by.as<std::string>());
            OptionalString distinct_ = distinct_by.isNull() || distinct_by.isUndefined()
                ? std::nullopt : std::optional<std::string>(distinct_by.as<std::string>());
            return ref_->get()->count(table_name, where, group, distinct_);
        } catch (const std::exception& e) {
            throw_js_error(std::string("count failed: ") + e.what());
        } catch (...) {
            throw_js_error("count failed: unknown error");
        }
        return 0;
    }

    // Remove object by ID
    bool remove(const std::string& table_name, int64_t id) {
        try {
            auto result = ref_->get()->object(id, table_name);
            if (!result) return false;
            return ref_->get()->remove(*result);
        } catch (const std::exception& e) {
            throw_js_error(std::string("remove failed: ") + e.what());
        } catch (...) {
            throw_js_error("remove failed: unknown error");
        }
        return false;
    }

    // Transaction control
    void beginWrite() {
        try {
            ref_->get()->begin_transaction();
        } catch (const std::exception& e) {
            throw_js_error(std::string("beginWrite failed: ") + e.what());
        } catch (...) {
            throw_js_error("beginWrite failed: unknown error");
        }
    }

    void commitWrite() {
        try {
            ref_->get()->commit();
        } catch (const std::exception& e) {
            throw_js_error(std::string("commitWrite failed: ") + e.what());
        } catch (...) {
            throw_js_error("commitWrite failed: unknown error");
        }
    }

    // Path getter
    std::string path() const {
        return ref_->get()->path();
    }

    // Debug: Query a table directly and return count
    int debugQueryCount(const std::string& sql) {
        try {
            auto rows = ref_->get()->read_db().query(sql, {});
            printf("[debugQueryCount] SQL: %s\nResult: %zu rows\n", sql.c_str(), rows.size());
            if (!rows.empty()) {
                for (const auto& row : rows) {
                    for (const auto& [k, v] : row) {
                        if (std::holds_alternative<std::string>(v)) {
                            printf("  %s = '%s'\n", k.c_str(), std::get<std::string>(v).c_str());
                        } else if (std::holds_alternative<int64_t>(v)) {
                            printf("  %s = %lld\n", k.c_str(), (long long)std::get<int64_t>(v));
                        } else if (std::holds_alternative<double>(v)) {
                            printf("  %s = %f\n", k.c_str(), std::get<double>(v));
                        }
                    }
                }
            }
            return static_cast<int>(rows.size());
        } catch (const std::exception& e) {
            printf("[debugQueryCount] Error: %s\n", e.what());
            return -1;
        }
    }

    // Debug: List all tables
    std::string debugListTables() {
        try {
            auto rows = ref_->get()->read_db().query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", {});
            std::string result;
            for (const auto& row : rows) {
                auto it = row.find("name");
                if (it != row.end() && std::holds_alternative<std::string>(it->second)) {
                    result += std::get<std::string>(it->second) + "\n";
                }
            }
            printf("[debugListTables] Tables:\n%s", result.c_str());
            return result;
        } catch (const std::exception& e) {
            printf("[debugListTables] Error: %s\n", e.what());
            return "";
        }
    }

    // Create an unmanaged dynamic object for a table (used before add)
    JsDynamicObject createObject(const std::string& table_name) {
        try {
            auto* schema = ref_->get()->get_properties_for_table(table_name);
            if (!schema) {
                throw_js_error("Unknown table: " + table_name);
                return JsDynamicObject();
            }

            // Create swift_dynamic_object with table name AND properties
            swift_dynamic_object unmanaged_obj(table_name, *schema);

            // Wrap in dynamic_object_ref
            auto* obj_ref = new dynamic_object_ref(unmanaged_obj);
            retainDynamicObjectRef(obj_ref);

            return JsDynamicObject(obj_ref);
        } catch (const std::exception& e) {
            throw_js_error(std::string("createObject failed: ") + e.what());
        } catch (...) {
            throw_js_error("createObject failed: unknown error");
        }
        return JsDynamicObject();
    }

    // Add a JsDynamicObject to the database
    JsDynamicObject addObject(const std::string& table_name, JsDynamicObject& obj) {
        try {
            if (!obj.isValid()) {
                throw_js_error("Cannot add invalid object");
                return JsDynamicObject();
            }

            // Add to database
            ref_->get()->add(*obj.raw()->get());

            // The object is now managed - return it with the id set
            return obj;
        } catch (const std::exception& e) {
            throw_js_error(std::string("addObject failed: ") + e.what());
        } catch (...) {
            throw_js_error("addObject failed: unknown error");
        }
        return JsDynamicObject();
    }

    // Find object by ID and return as JsDynamicObject
    JsDynamicObject findObject(const std::string& table_name, int64_t id) {
        try {
            auto result = ref_->get()->object(id, table_name);
            if (!result) {
                return JsDynamicObject();
            }

            // Create a dynamic_object_ref from the managed object
            auto* obj_ref = new dynamic_object_ref(*result);
            retainDynamicObjectRef(obj_ref);

            return JsDynamicObject(obj_ref);
        } catch (const std::exception& e) {
            throw_js_error(std::string("findObject failed: ") + e.what());
        } catch (...) {
            throw_js_error("findObject failed: unknown error");
        }
        return JsDynamicObject();
    }

    // ========================================================================
    // Audit Log / Sync Methods
    // ========================================================================

    // Get all audit log entries as JSON (for initial sync to new tabs)
    // Uses only_unsynced=false to include entries received from other tabs
    std::string getPendingAuditLog() {
        try {
            // Return ALL entries, not just unsynced, so new tabs can get data
            // that was received from other tabs (which are marked isFromRemote=1)
            auto entries = query_audit_log(ref_->get()->db(), false, std::nullopt);

            // Build JSON array
            std::string json = "[";
            for (size_t i = 0; i < entries.size(); i++) {
                if (i > 0) json += ",";
                json += entries[i].to_json();
            }
            json += "]";

            return json;
        } catch (const std::exception& e) {
            printf("[getPendingAuditLog] Error: %s\n", e.what());
            return "[]";
        }
    }

    // The rows this store still OWES upstream — the drain predicate, in SQL.
    // getPendingAuditLog() cannot express it: a row the SYNCHRONIZER applied
    // (a download) is recorded isSynchronized=0 with its ACK in
    // `_lattice_sync_state` (per-sync_id, invisible to the global flag until
    // heal collapses it), while a stranded LOCAL write — and a row a drain or
    // sibling relay applied — has no such mark. So: unsynced AND unmarked.
    // Downloads excluded, local writes + second-generation rescues included,
    // no reliance on isFromRemote heuristics.
    std::string getUnshippedAuditLog() {
        try {
            auto& db = ref_->get()->db();
            std::unordered_set<int64_t> acked;
            if (db.table_exists("_lattice_sync_state")) {
                auto rows = db.query(
                    "SELECT DISTINCT audit_entry_id FROM _lattice_sync_state "
                    "WHERE is_synchronized = 1", {});
                for (const auto& row : rows) {
                    auto it = row.find("audit_entry_id");
                    if (it != row.end() && std::holds_alternative<int64_t>(it->second)) {
                        acked.insert(std::get<int64_t>(it->second));
                    }
                }
            }
            // only_unsynced=true would ALSO filter isFromRemote=0 in core —
            // silently dropping rows a drain or sibling relay applied
            // (isFromRemote=1, unsynced, unmarked), i.e. making a
            // second-generation rescue lossy. Take every row and apply the
            // documented predicate ourselves: unsynced AND unmarked.
            auto entries = query_audit_log(db, false /*all rows*/, std::nullopt);
            std::string json = "[";
            bool first = true;
            for (const auto& entry : entries) {
                if (entry.is_synchronized) continue;
                if (acked.count(entry.id)) continue;
                if (!first) json += ",";
                first = false;
                json += entry.to_json();
            }
            json += "]";
            return json;
        } catch (const std::exception& e) {
            printf("[getUnshippedAuditLog] Error: %s\n", e.what());
            return "[]";
        }
    }

    // Release this handle's reference to the underlying store. For a
    // read-only audit open (which holds the ONLY reference) this closes the
    // sqlite connection — embind's .delete() alone frees just the wrapper
    // and leaked one connection per abandoned store. Idempotent; every other
    // method is invalid after this. Cached/writable instances shared with a
    // live page merely drop one reference.
    void releaseStorage() {
        if (ref_ && owns_reference_) {
            releaseSwiftLatticeRef(ref_);   // 1 → 0: deletes the wrapper, releases the only shared_ptr
            ref_ = nullptr;
            owns_reference_ = false;
        }
        // Cached/writable handles never retained (their survival across
        // .delete() is load-bearing for same-path sharing — see
        // src/sync-socket.ts), so releasing here would underflow; no-op.
    }

    // Checkpoint WAL to flush all changes into the main database file.
    // Call this before reading the DB file for persistence.
    void walCheckpoint() {
        try {
            ref_->get()->db().execute("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch (const std::exception& e) {
            printf("[walCheckpoint] Error: %s\n", e.what());
        }
    }

    // Apply remote changes from JSON (audit log entries)
    // Returns JSON array of global IDs that were applied
    std::string applyRemoteChanges(const std::string& json) {
        try {
            // Parse JSON array of audit log entries
            auto j = nlohmann::json::parse(json);
            if (!j.is_array()) {
                printf("[applyRemoteChanges] Expected JSON array\n");
                return "[]";
            }

            std::vector<std::string> applied_ids;
            std::vector<audit_log_entry> entries_to_record;

            // Disable sync triggers while applying remote changes
            // (we'll manually insert AuditLog entries with isFromRemote=1)
            ref_->get()->db().execute("UPDATE _SyncControl SET disabled = 1 WHERE id = 1");

            for (const auto& entry_json : j) {
                auto entry = audit_log_entry::from_json(entry_json.dump());
                if (!entry) {
                    printf("[applyRemoteChanges] Failed to parse entry\n");
                    continue;
                }

                // Get schema for table to handle BLOB columns
                const auto* props = ref_->get()->get_properties_for_table(entry->table_name);
                std::unordered_map<std::string, column_type> schema;
                if (props) {
                    for (const auto& [name, desc] : *props) {
                        schema[name] = desc.type;
                    }
                }

                // Generate and execute the SQL instruction
                auto [sql, params] = entry->generate_instruction(schema);
                if (!sql.empty()) {
                    try {
                        ref_->get()->db().execute(sql, params);
                        applied_ids.push_back(entry->global_id);
                        entries_to_record.push_back(*entry);
                    } catch (const std::exception& e) {
                        char buf[1024];
                        snprintf(buf, sizeof(buf), "applyRemoteChanges SQL FAILED: %s | SQL: %.500s | table: %s op: %s",
                                 e.what(), sql.c_str(), entry->table_name.c_str(), entry->operation.c_str());
                        debugLogToChannel(buf);
                    }
                }
            }

            // Re-enable sync triggers
            ref_->get()->db().execute("UPDATE _SyncControl SET disabled = 0 WHERE id = 1");

            // Now manually insert AuditLog entries for applied changes
            // Mark them as isFromRemote=1 so we don't re-broadcast them
            for (const auto& entry : entries_to_record) {
                try {
                    ref_->get()->db().execute(
                        "INSERT OR REPLACE INTO AuditLog "
                        "(globalId, tableName, operation, rowId, globalRowId, changedFields, changedFieldsNames, timestamp, isFromRemote, isSynchronized) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)",
                        {
                            entry.global_id,
                            entry.table_name,
                            entry.operation,
                            entry.row_id,
                            entry.global_row_id,
                            entry.changed_fields_to_json(),
                            entry.changed_fields_names_to_json(),
                            entry.timestamp
                        }
                    );
                } catch (const std::exception& e) {
                    printf("[applyRemoteChanges] Failed to record AuditLog entry: %s\n", e.what());
                }
            }

            // Return applied IDs as JSON array
            nlohmann::json result = applied_ids;
            return result.dump();
        } catch (const std::exception& e) {
            printf("[applyRemoteChanges] Error: %s\n", e.what());
            return "[]";
        }
    }

    // Mark audit log entries as synchronized
    void markEntriesSynced(const std::string& idsJson) {
        try {
            auto j = nlohmann::json::parse(idsJson);
            if (!j.is_array()) return;

            std::vector<std::string> ids;
            for (const auto& id : j) {
                if (id.is_string()) {
                    ids.push_back(id.get<std::string>());
                }
            }

            mark_audit_entries_synced(*ref_->get(), ids);
        } catch (const std::exception& e) {
            printf("[markEntriesSynced] Error: %s\n", e.what());
        }
    }

    // Receive sync data (ServerSentEvent JSON) - for server-side sync
    // Returns JSON array of applied global IDs
    std::string receive(const std::string& json) {
        try {
            auto event = server_sent_event::from_json(json);
            if (!event) return "[]";

            std::vector<std::string> applied_ids;

            if (event->event_type == server_sent_event::type::audit_log) {

                // Disable sync triggers while applying
                ref_->get()->db().execute("UPDATE _SyncControl SET disabled = 1 WHERE id = 1");

                for (const auto& entry : event->audit_logs) {
                    // Skip if already in AuditLog (idempotent)
                    auto existing = ref_->get()->db().query(
                        "SELECT id FROM AuditLog WHERE globalId = ?",
                        {entry.global_id}
                    );
                    if (!existing.empty()) continue;

                    // Get schema for table
                    const auto* props = ref_->get()->get_properties_for_table(entry.table_name);
                    std::unordered_map<std::string, column_type> schema;
                    if (props) {
                        for (const auto& [name, desc] : *props) {
                            schema[name] = desc.type;
                        }
                    }

                    // Generate and execute SQL for data table
                    auto [sql, params] = entry.generate_instruction(schema);
                    if (!sql.empty()) {
                        try {
                            ref_->get()->db().execute(sql, params);

                            // Record the audit entry as from remote (for eventsAfter queries)
                            std::string insert_sql = R"(
                                INSERT INTO AuditLog (globalId, tableName, operation, rowId, globalRowId,
                                    changedFields, changedFieldsNames, timestamp, isFromRemote, isSynchronized)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
                            )";
                            ref_->get()->db().execute(insert_sql, {
                                entry.global_id,
                                entry.table_name,
                                entry.operation,
                                entry.row_id,
                                entry.global_row_id,
                                entry.changed_fields_to_json(),
                                entry.changed_fields_names_to_json(),
                                entry.timestamp
                            });

                            applied_ids.push_back(entry.global_id);
                        } catch (const std::exception& e) {
                        }
                    }
                }

                // Re-enable sync triggers
                ref_->get()->db().execute("UPDATE _SyncControl SET disabled = 0 WHERE id = 1");

            } else if (event->event_type == server_sent_event::type::ack) {
                mark_audit_entries_synced(*ref_->get(), event->acked_ids);
                applied_ids = event->acked_ids;
            }

            nlohmann::json result = applied_ids;
            return result.dump();
        } catch (const std::exception& e) {
            printf("[receive] Error: %s\n", e.what());
            return "[]";
        }
    }

    // Get audit log events after a checkpoint (for server-side sync)
    // Returns JSON array of audit log entries
    std::string eventsAfter(const std::string& checkpointGlobalId) {
        try {
            std::optional<std::string> checkpoint = std::nullopt;
            if (!checkpointGlobalId.empty()) {
                checkpoint = checkpointGlobalId;
            }

            auto entries = events_after(ref_->get()->db(), checkpoint);
            printf("[eventsAfter] Found %zu entries after checkpoint\n", entries.size());

            // Convert to JSON array
            std::string json = "[";
            for (size_t i = 0; i < entries.size(); i++) {
                if (i > 0) json += ",";
                json += entries[i].to_json();
            }
            json += "]";

            return json;
        } catch (const std::exception& e) {
            printf("[eventsAfter] Error: %s\n", e.what());
            return "[]";
        }
    }

    // Observe AuditLog table for changes
    // Calls the JS callback with JSON of new entries when INSERTs happen
    // Returns observer ID (for removal)
    uint64_t observeAuditLog(val callback) {
        try {
            struct AuditLogContext {
                val* callback;
            };
            auto* ctx = new AuditLogContext{new val(callback)};

            auto observer_id = ref_->get()->add_table_observer("AuditLog", ctx,
                // Batched observer contract: one call per WAL flush with
                // parallel arrays (count rows of op/rowId/globalRowId).
                [](void* context, const char* const* operations, const int64_t* row_ids,
                   const char* const* global_row_ids, size_t count) {
                    auto* ctx = static_cast<AuditLogContext*>(context);
                    std::string json = "[";
                    bool any = false;
                    for (size_t i = 0; i < count; ++i) {
                        if (std::string(operations[i]) != "INSERT") continue;
                        std::string gid(global_row_ids[i] ? global_row_ids[i] : "");
                        if (any) json += ",";
                        json += "{\"globalId\":\"" + gid + "\",\"operation\":\"" +
                                std::string(operations[i]) + "\",\"rowId\":" +
                                std::to_string(row_ids[i]) + "}";
                        any = true;
                    }
                    json += "]";
                    if (any) (*(ctx->callback))(json);
                },
                [](void* context) {
                    auto* ctx = static_cast<AuditLogContext*>(context);
                    delete ctx->callback;
                    delete ctx;
                });

            observer_callbacks_[observer_id] = ctx->callback;
            return observer_id;
        } catch (const std::exception& e) {
            return 0;
        }
    }

    // Observe a specific model table for changes.
    // Callback receives a CollectionChange val: {operation, rowId, globalRowId}
    // globalRowId IS the entity's own globalId (not an AuditLog entry ID).
    uint64_t observeTable(const std::string& table_name, val callback) {
        try {
            auto* stored_callback = new val(callback);
            auto observer_id = ref_->get()->add_table_observer(table_name, stored_callback,
                // Batched observer contract — deliver one JS callback per row
                // to preserve the historical per-event shape.
                [](void* context, const char* const* operations, const int64_t* row_ids,
                   const char* const* global_row_ids, size_t count) {
                    auto* cb = static_cast<val*>(context);
                    for (size_t i = 0; i < count; ++i) {
                        val entry = val::object();
                        entry.set("operation", val(std::string(operations[i])));
                        entry.set("rowId", val(static_cast<double>(row_ids[i])));
                        entry.set("globalRowId", val(std::string(global_row_ids[i] ? global_row_ids[i] : "")));
                        (*cb)(entry);
                    }
                });
            observer_callbacks_[observer_id] = stored_callback;
            return observer_id;
        } catch (const std::exception& e) {
            return 0;
        }
    }

    // Remove an audit log observer
    void removeAuditLogObserver(uint64_t observer_id) {
        try {
            ref_->get()->remove_table_observer("AuditLog", observer_id);

            // Clean up stored callback
            auto it = observer_callbacks_.find(observer_id);
            if (it != observer_callbacks_.end()) {
                delete it->second;
                observer_callbacks_.erase(it);
            }
        } catch (const std::exception& e) {
            printf("[removeAuditLogObserver] Error: %s\n", e.what());
        }
    }

    // Remove a table observer by ID and table name
    void removeTableObserver(const std::string& table_name, uint64_t observer_id) {
        try {
            ref_->get()->remove_table_observer(table_name, observer_id);
            auto it = observer_callbacks_.find(observer_id);
            if (it != observer_callbacks_.end()) {
                delete it->second;
                observer_callbacks_.erase(it);
            }
        } catch (const std::exception& e) {
            printf("[removeTableObserver] Error: %s\n", e.what());
        }
    }

    // ========================================================================
    // Bulk Insert
    // ========================================================================

    val addBulk(const std::string& table_name, const val& js_array) {
        try {
            auto length = js_array["length"].as<size_t>();
            auto* schema = ref_->get()->get_properties_for_table(table_name);
            if (!schema) {
                throw_js_error("Unknown table: " + table_name);
                return val::array();
            }

            ref_->get()->begin_transaction();

            val result = val::array();
            for (size_t i = 0; i < length; i++) {
                val js_obj = js_array[i];

                // Create swift_dynamic_object the same way as add()
                swift_dynamic_object unmanaged_obj(table_name, *schema);
                auto* obj_ref = new dynamic_object_ref(unmanaged_obj);
                retainDynamicObjectRef(obj_ref);

                js_to_dynamic_object(obj_ref, js_obj, schema, ref_->get());
                ref_->get()->add(*obj_ref->get());

                val entry = val::object();
                entry.set("id", val(static_cast<double>(obj_ref->get_int("id"))));
                entry.set("globalId", val(obj_ref->get_string("globalId")));
                result.call<void>("push", entry);

                releaseDynamicObjectRef(obj_ref);
            }

            ref_->get()->commit();
            return result;
        } catch (const std::exception& e) {
            ref_->get()->rollback();
            throw_js_error(std::string("addBulk failed: ") + e.what());
        }
        return val::array();
    }

    // ========================================================================
    // Fine-grained Observation
    // ========================================================================

    uint64_t observeObject(const std::string& table_name, int64_t row_id, val callback) {
        try {
            auto* stored_callback = new val(callback);
            auto observer_id = ref_->get()->add_object_observer(table_name, row_id, stored_callback,
                [](const char* changed_fields_names, void* context) {
                    auto* cb = static_cast<val*>(context);
                    (*cb)(val(std::string(changed_fields_names)));
                });
            observer_callbacks_[observer_id] = stored_callback;
            return observer_id;
        } catch (const std::exception& e) {
            throw_js_error(std::string("observeObject failed: ") + e.what());
        }
        return 0;
    }

    void removeObjectObserver(const std::string& table_name, int64_t row_id, uint64_t observer_id) {
        try {
            ref_->get()->remove_object_observer(table_name, row_id, observer_id);
            auto it = observer_callbacks_.find(observer_id);
            if (it != observer_callbacks_.end()) {
                delete it->second;
                observer_callbacks_.erase(it);
            }
        } catch (const std::exception& e) {
            printf("[removeObjectObserver] Error: %s\n", e.what());
        }
    }

    // ========================================================================
    // FTS5 Full-Text Search
    // ========================================================================

    val ftsQuery(const std::string& table_name, const std::string& column_name,
                 const std::string& search_text, int limit) {
        try {
            // FTS5 virtual table is named _{table}_{column}_fts
            std::string fts_table = "_" + table_name + "_" + column_name + "_fts";
            std::string sql =
                "SELECT T.* FROM " + table_name + " T "
                "JOIN " + fts_table + " fts ON T.id = fts.rowid "
                "WHERE " + fts_table + " MATCH '" + search_text + "' "
                "ORDER BY rank "
                "LIMIT " + std::to_string(limit);

            auto results = ref_->get()->objects(table_name,
                "id IN (SELECT rowid FROM " + fts_table + " WHERE " + fts_table + " MATCH '" + search_text + "' ORDER BY rank LIMIT " + std::to_string(limit) + ")",
                std::nullopt, std::nullopt, std::nullopt);
            auto* schema = ref_->get()->get_properties_for_table(table_name);

            val arr = val::array();
            for (size_t i = 0; i < results.size(); i++) {
                auto* obj_ref = new dynamic_object_ref(results[i]);
                val js_obj = dynamic_object_to_js(obj_ref, schema);
                js_obj.set("id", results[i].id());
                js_obj.set("globalId", results[i].global_id());
                arr.call<void>("push", js_obj);
                delete obj_ref;
            }
            return arr;
        } catch (const std::exception& e) {
            throw_js_error(std::string("ftsQuery failed: ") + e.what());
        }
        return val::array();
    }

    // ========================================================================
    // Vector Search (sqlite-vec nearest neighbors)
    // ========================================================================

    val nearestNeighbors(const std::string& table_name, const std::string& column_name,
                         const val& query_vector_js, int k, int metric_int,
                         const val& where_clause) {
        try {
            // Convert JS Float32Array to vector<uint8_t>
            size_t vec_length = query_vector_js["length"].as<size_t>();
            std::vector<float> float_vec(vec_length);
            for (size_t i = 0; i < vec_length; i++) {
                float_vec[i] = query_vector_js[i].as<float>();
            }
            // Reinterpret as bytes
            std::vector<uint8_t> query_bytes(
                reinterpret_cast<uint8_t*>(float_vec.data()),
                reinterpret_cast<uint8_t*>(float_vec.data()) + float_vec.size() * sizeof(float));

            auto results = ref_->get()->nearest_neighbors_ids(table_name, column_name, query_bytes, k, metric_int);

            val arr = val::array();
            for (const auto& r : results) {
                val entry = val::object();
                entry.set("globalId", val(r.global_id));
                entry.set("distance", val(r.distance));
                arr.call<void>("push", entry);
            }
            return arr;
        } catch (const std::exception& e) {
            throw_js_error(std::string("nearestNeighbors failed: ") + e.what());
        }
        return val::array();
    }

    // ========================================================================
    // Sync Progress / Filters / Compaction
    // ========================================================================

    val getSyncProgress() {
        try {
            auto progress = ref_->get()->get_sync_progress();
            val result = val::object();
            result.set("pendingUpload", val(static_cast<double>(progress.pending_upload)));
            result.set("totalUpload", val(static_cast<double>(progress.total_upload)));
            result.set("acked", val(static_cast<double>(progress.acked)));
            result.set("received", val(static_cast<double>(progress.received)));
            return result;
        } catch (const std::exception& e) {
            throw_js_error(std::string("getSyncProgress failed: ") + e.what());
        }
        return val::object();
    }

    uint64_t onSyncProgress(val callback) {
        try {
            auto* stored_callback = new val(callback);
            ref_->get()->set_on_sync_progress(stored_callback,
                // 6-arg shape as of LatticeCore 1.3.x: sync_id labels which
                // channel the update belongs to (multiple synchronizers
                // multiplex one callback). Surfaced to JS as `syncId`.
                [](void* context, int64_t pending, int64_t total, int64_t acked,
                   int64_t received, const char* sync_id) {
                    auto* cb = static_cast<val*>(context);
                    val progress = val::object();
                    progress.set("pendingUpload", val(static_cast<double>(pending)));
                    progress.set("totalUpload", val(static_cast<double>(total)));
                    progress.set("acked", val(static_cast<double>(acked)));
                    progress.set("received", val(static_cast<double>(received)));
                    progress.set("syncId", val(std::string(sync_id ? sync_id : "")));
                    (*cb)(progress);
                });
            // Store for cleanup - use a special key
            uint64_t key = reinterpret_cast<uintptr_t>(stored_callback);
            observer_callbacks_[key] = stored_callback;
            return key;
        } catch (const std::exception& e) {
            throw_js_error(std::string("onSyncProgress failed: ") + e.what());
        }
        return 0;
    }

    void updateSyncFilter(const std::string& filter_json) {
        try {
            auto j = nlohmann::json::parse(filter_json);
            std::vector<sync_filter_entry> filter;
            for (const auto& entry : j) {
                sync_filter_entry f;
                f.table_name = entry["tableName"].get<std::string>();
                if (entry.contains("whereClause") && !entry["whereClause"].is_null()) {
                    f.where_clause = entry["whereClause"].get<std::string>();
                }
                filter.push_back(f);
            }
            ref_->get()->update_sync_filter(filter);
        } catch (const std::exception& e) {
            throw_js_error(std::string("updateSyncFilter failed: ") + e.what());
        }
    }

    void clearSyncFilter() {
        try {
            ref_->get()->clear_sync_filter();
        } catch (const std::exception& e) {
            throw_js_error(std::string("clearSyncFilter failed: ") + e.what());
        }
    }

    int64_t compactAuditLog() {
        try {
            return ref_->get()->force_compact_audit_log();
        } catch (const std::exception& e) {
            throw_js_error(std::string("compactAuditLog failed: ") + e.what());
        }
        return 0;
    }

    int64_t safeCompactAuditLog(int64_t stale_threshold_seconds) {
        try {
            return ref_->get()->safe_compact_audit_log(stale_threshold_seconds);
        } catch (const std::exception& e) {
            throw_js_error(std::string("safeCompactAuditLog failed: ") + e.what());
        }
        return 0;
    }

    int64_t generateHistory() {
        try {
            return ref_->get()->generate_history();
        } catch (const std::exception& e) {
            throw_js_error(std::string("generateHistory failed: ") + e.what());
        }
        return 0;
    }

private:
    swift_lattice_ref* ref_ = nullptr;
    std::unordered_map<uint64_t, val*> observer_callbacks_;
};

// ============================================================================
// Standalone function to create unmanaged DynamicObject (for use in decorators)
// ============================================================================

JsDynamicObject createDynamicObject(const std::string& table_name, const val& properties) {
    try {
        // Convert JS properties array to SwiftSchema
        SwiftSchema schema;
        auto length = properties["length"].as<size_t>();
        for (size_t i = 0; i < length; i++) {
            auto desc = js_to_property_descriptor(properties[i]);
            schema[desc.name] = desc;
        }

        // Create unmanaged swift_dynamic_object
        swift_dynamic_object unmanaged_obj(table_name, schema);

        // Wrap in dynamic_object_ref
        auto* obj_ref = new dynamic_object_ref(unmanaged_obj);
        retainDynamicObjectRef(obj_ref);

        return JsDynamicObject(obj_ref);
    } catch (const std::exception& e) {
        printf("[createDynamicObject] Error: %s\n", e.what());
        return JsDynamicObject();
    } catch (...) {
        printf("[createDynamicObject] Unknown error\n");
        return JsDynamicObject();
    }
}

// ============================================================================
// Sync Message Creation (for test server)
// ============================================================================

// Create a sync message from audit log entries JSON array
std::string createSyncMessage(const std::string& entriesJson) {
    try {
        // Parse the entries JSON array
        auto j = nlohmann::json::parse(entriesJson);
        if (!j.is_array()) {
            printf("[createSyncMessage] Expected array\n");
            return "";
        }

        std::vector<audit_log_entry> entries;
        for (const auto& entry_json : j) {
            auto entry = audit_log_entry::from_json(entry_json.dump());
            if (entry) {
                entries.push_back(*entry);
            }
        }

        if (entries.empty()) {
            return "";
        }
        auto event = server_sent_event::make_audit_log(std::move(entries));
        return event.to_json();
    } catch (const std::exception& e) {
        printf("[createSyncMessage] Error: %s\n", e.what());
        return "";
    }
}

// Create an ack message from global IDs JSON array
std::string createAckMessage(const std::string& idsJson) {
    try {
        // Parse the IDs JSON array
        std::vector<std::string> ids;
        // Simple JSON array parsing
        auto json = nlohmann::json::parse(idsJson);
        for (const auto& id : json) {
            ids.push_back(id.get<std::string>());
        }
        if (ids.empty()) {
            return "";
        }
        auto event = server_sent_event::make_ack(std::move(ids));
        return event.to_json();
    } catch (const std::exception& e) {
        printf("[createAckMessage] Error: %s\n", e.what());
        return "";
    }
}

// ============================================================================
// Embind bindings
// ============================================================================

// Simple test function to check WASM version
std::string getWasmVersion() {
    return "opfs-vfs-v3";  // Change this to track versions
}

// Enable SQLite shared cache mode globally.
// This is required for file::memory:?cache=shared to work — without it,
// each connection opening the URI gets its own isolated in-memory database,
// breaking the sync_db ↔ main_db shared state pattern.
__attribute__((constructor))
static void enable_shared_cache() {
    sqlite3_enable_shared_cache(1);
    printf("[WASM] SQLite shared cache enabled globally\n");
}

EMSCRIPTEN_BINDINGS(lattice) {
    // Version check
    function("getWasmVersion", &getWasmVersion);

    // Sync message creation (for test server)
    function("createSyncMessage", &createSyncMessage);
    function("createAckMessage", &createAckMessage);

    // OPFS initialization
    function("initOPFSAsync", &initOPFSAsync);  // Async via pthread (for main thread)
    function("initOPFSSync", &initOPFSSync);    // Sync (for SharedWorker)
    function("isOPFSAvailable", &isOPFSAvailable);
    function("isOPFSInitInProgress", &isOPFSInitInProgress);
    function("isOPFSInitFailed", &isOPFSInitFailed);

    // Standalone function for creating unmanaged objects (called from decorators)
    function("createDynamicObject", &createDynamicObject);
    // JsLinkList - C++ backing for List<T> properties
    class_<JsLinkList>("LinkList")
        .constructor<>()
        .function("isValid", &JsLinkList::isValid)
        .function("size", &JsLinkList::size)
        .function("empty", &JsLinkList::empty)
        .function("at", &JsLinkList::at)
        .function("push_back", &JsLinkList::push_back)
        .function("erase", &JsLinkList::erase)
        .function("clear", &JsLinkList::clear);

    // JsDynamicObject - C++ backing storage for model instances
    class_<JsDynamicObject>("DynamicObject")
        .constructor<>()
        .function("isValid", &JsDynamicObject::isValid)
        .function("getInt", &JsDynamicObject::getInt)
        .function("getString", &JsDynamicObject::getString)
        .function("getDouble", &JsDynamicObject::getDouble)
        .function("getBool", &JsDynamicObject::getBool)
        .function("hasValue", &JsDynamicObject::hasValue)
        .function("setInt", &JsDynamicObject::setInt)
        .function("setString", &JsDynamicObject::setString)
        .function("setDouble", &JsDynamicObject::setDouble)
        .function("setBool", &JsDynamicObject::setBool)
        .function("setNil", &JsDynamicObject::setNil)
        .function("getObject", &JsDynamicObject::getObject)
        .function("setObject", &JsDynamicObject::setObject)
        .function("getLinkList", &JsDynamicObject::getLinkList);

    class_<JsLattice>("Lattice")
        .constructor<std::string, val>()
        .constructor<std::string, val, bool>()
        .constructor<std::string, val, std::string, std::string>()
        .constructor<std::string, val, std::string, std::string, int32_t, val>()
        .function("add", &JsLattice::add)
        .function("addObject", &JsLattice::addObject)
        .function("find", &JsLattice::find)
        .function("findObject", &JsLattice::findObject)
        .function("findByGlobalId", &JsLattice::findByGlobalId)
        .function("objects", &JsLattice::objects)
        .function("count", &JsLattice::count)
        .function("remove", &JsLattice::remove)
        .function("beginWrite", &JsLattice::beginWrite)
        .function("commitWrite", &JsLattice::commitWrite)
        .function("createObject", &JsLattice::createObject)
        .function("debugQueryCount", &JsLattice::debugQueryCount)
        .function("debugListTables", &JsLattice::debugListTables)
        .property("path", &JsLattice::path)
        // Audit log / sync methods
        .function("getPendingAuditLog", &JsLattice::getPendingAuditLog)
        .function("getUnshippedAuditLog", &JsLattice::getUnshippedAuditLog)
        .function("releaseStorage", &JsLattice::releaseStorage)
        .function("walCheckpoint", &JsLattice::walCheckpoint)
        .function("applyRemoteChanges", &JsLattice::applyRemoteChanges)
        .function("markEntriesSynced", &JsLattice::markEntriesSynced)
        .function("observeAuditLog", &JsLattice::observeAuditLog)
        .function("removeAuditLogObserver", &JsLattice::removeAuditLogObserver)
        .function("observeTable", &JsLattice::observeTable)
        .function("removeTableObserver", &JsLattice::removeTableObserver)
        // Server-side sync methods (for test server)
        .function("receive", &JsLattice::receive)
        .function("eventsAfter", &JsLattice::eventsAfter)
        // Bulk insert
        .function("addBulk", &JsLattice::addBulk)
        // Fine-grained observation
        .function("observeObject", &JsLattice::observeObject)
        .function("removeObjectObserver", &JsLattice::removeObjectObserver)
        // FTS5 full-text search
        .function("ftsQuery", &JsLattice::ftsQuery)
        // Vector search
        .function("nearestNeighbors", &JsLattice::nearestNeighbors)
        // Sync progress / filters / compaction
        .function("getSyncProgress", &JsLattice::getSyncProgress)
        .function("onSyncProgress", &JsLattice::onSyncProgress)
        .function("updateSyncFilter", &JsLattice::updateSyncFilter)
        .function("clearSyncFilter", &JsLattice::clearSyncFilter)
        .function("compactAuditLog", &JsLattice::compactAuditLog)
        .function("safeCompactAuditLog", &JsLattice::safeCompactAuditLog)
        .function("generateHistory", &JsLattice::generateHistory);
}
