#pragma once
// Separate source packet: no Embind/JS calls belong inside capture_native().
// Initial qualification is single-thread Wasm only. A callback-free native copy
// is required because the Emscripten Core read-generation API returns zero.
#include <lattice.hpp>
#include <dynamic_object.hpp>
#include <lattice/log.hpp>
#include <cmath>
#include <map>
#include <set>
#include <variant>

namespace lattice_js_capture {
constexpr size_t max_selectors = 16, max_properties = 64, max_rows = 16384;
constexpr size_t max_cell_bytes = 262144, max_bytes = 8 * 1024 * 1024, max_work = 262144;
struct selector { std::string table; std::vector<std::string> properties; size_t max_rows = lattice_js_capture::max_rows; };
struct link { std::string table, global_id; };
using value = std::variant<std::nullptr_t, int64_t, double, std::string, std::vector<uint8_t>, link>;
struct row { std::string table, global_id; std::map<std::string, value> values; };
struct snapshot { std::vector<row> rows; };

inline void require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
inline bool identifier(const std::string& input) {
    if (input.empty() || input.size() > 128) return false;
    for (size_t i = 0; i < input.size(); ++i) {
        const auto c = static_cast<unsigned char>(input[i]);
        if (!(c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (i && c >= '0' && c <= '9'))) return false;
    }
    return true;
}
inline std::string folded(std::string input) { for (auto& c : input) if (c >= 'A' && c <= 'Z') c += 'a' - 'A'; return input; }
inline std::string quote_identifier(const std::string& input) {
    std::string result = "\"";
    for (const char c : input) { result += c; if (c == '"') result += c; }
    return result + "\"";
}
inline int64_t integer(const lattice::database::row_t& input, const std::string& key) {
    const auto found = input.find(key);
    require(found != input.end() && std::holds_alternative<int64_t>(found->second), "Capture preflight returned invalid integer");
    return std::get<int64_t>(found->second);
}
inline std::string text(const lattice::database::row_t& input, const std::string& key) {
    const auto found = input.find(key);
    require(found != input.end() && std::holds_alternative<std::string>(found->second), "Capture preflight returned invalid text");
    return std::get<std::string>(found->second);
}
inline bool valid_utf8(const std::string& input) {
    for (size_t i = 0; i < input.size();) {
        const auto c = static_cast<unsigned char>(input[i++]);
        if (c < 0x80) continue;
        size_t remaining; uint32_t code, minimum;
        if (c >= 0xc2 && c <= 0xdf) { remaining = 1; code = c & 0x1f; minimum = 0x80; }
        else if (c >= 0xe0 && c <= 0xef) { remaining = 2; code = c & 0x0f; minimum = 0x800; }
        else if (c >= 0xf0 && c <= 0xf4) { remaining = 3; code = c & 7; minimum = 0x10000; }
        else return false;
        if (input.size() - i < remaining) return false;
        while (remaining--) { const auto next = static_cast<unsigned char>(input[i++]); if ((next & 0xc0) != 0x80) return false; code = (code << 6) | (next & 0x3f); }
        if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
    }
    return true;
}
struct budget {
    size_t bytes = 0, work = 0;
    void cell(size_t amount) {
        require(amount <= max_cell_bytes, "Capture cell byte bound exceeded");
        require(amount <= max_bytes - bytes, "Capture aggregate byte bound exceeded"); bytes += amount;
    }
    // Aggregate lengths remain signed 64-bit until the bounded total is proven
    // safe to narrow on Wasm32. A column sum is not an individual cell.
    void physical_column(int64_t maximum, int64_t total) {
        require(maximum >= 0 && total >= maximum, "Invalid capture cell length");
        require(maximum <= static_cast<int64_t>(max_cell_bytes), "Capture cell byte bound exceeded");
        require(total <= static_cast<int64_t>(max_bytes - bytes), "Capture aggregate byte bound exceeded");
        bytes += static_cast<size_t>(total);
    }
    void string(const std::string& input) { cell(input.size()); require(valid_utf8(input), "Capture requires valid UTF-8 text"); }
    void cells(size_t amount) { require(amount <= max_work - work, "Capture work bound exceeded"); work += amount; }
};

// No additional transaction-depth bookkeeping exists in database: its active
// state is sqlite3_get_autocommit(). execute uses normal statement/hook scopes.
// Core's drain_if_settled cannot deliver observers while autocommit is off.
class read_scope {
    lattice::database& db_;
    lattice::log_level previous_;
    bool active_ = false;
public:
    explicit read_scope(lattice::database& db) : db_(db), previous_(lattice::get_log_level()) {
        require(!db_.is_closed(), "Capture requires an open database");
        require(!db_.is_in_transaction(), "Capture refuses an active transaction");
        // Logging can call Module.printErr. Global suppression is safe only
        // in the explicitly supported single-thread, non-yielding artifact.
        lattice::set_log_level(lattice::log_level::off);
        try { db_.execute("BEGIN DEFERRED"); active_ = true; }
        catch (...) { lattice::set_log_level(previous_); throw; }
    }
    void finish() {
        if (active_) {
            // Copy is complete before ending the read; any settled work can
            // only be scheduled/delivered after SQLite has left this scope.
            db_.rollback(); active_ = false;
        }
        lattice::set_log_level(previous_);
    }
    ~read_scope() noexcept {
        if (active_) { try { db_.rollback(); } catch (...) {} }
        lattice::set_log_level(previous_);
    }
    read_scope(const read_scope&) = delete;
    read_scope& operator=(const read_scope&) = delete;
};

inline snapshot capture_native(const std::shared_ptr<lattice::swift_lattice>& owner, const std::vector<selector>& selectors) {
#if !defined(__EMSCRIPTEN__) || defined(__EMSCRIPTEN_PTHREADS__) || defined(__EMSCRIPTEN_SHARED_MEMORY__) || defined(__EMSCRIPTEN_WASM_WORKERS__)
    throw std::runtime_error("Capture requires the qualified single-thread Wasm runtime");
#endif
    require(owner && !owner->is_closed(), "Capture requires an open database");
    require(!selectors.empty() && selectors.size() <= max_selectors, "Capture selector bound exceeded");
    struct plan { selector selection; std::vector<lattice::property_descriptor> properties; size_t count = 0; };
    std::vector<plan> plans; std::set<std::string> tables;
    for (const auto& input : selectors) {
        require(identifier(input.table) && tables.insert(folded(input.table)).second, "Invalid or duplicate capture table");
        require(input.max_rows > 0 && input.max_rows <= max_rows, "Invalid capture maxRows");
        require(!input.properties.empty() && input.properties.size() <= max_properties, "Capture property bound exceeded");
        const auto* schema = owner->get_properties_for_table(input.table);
        require(schema != nullptr, "Capture requires a registered table");
        plan next{input, {}}; std::set<std::string> names;
        for (const auto& property : input.properties) {
            require(identifier(property) && folded(property) != "id" && folded(property) != "globalid" && names.insert(folded(property)).second, "Invalid or duplicate capture property");
            const auto found = schema->find(property);
            require(found != schema->end(), "Unknown capture property");
            require(found->second.kind == lattice::property_kind::primitive || found->second.kind == lattice::property_kind::link, "Capture supports primitive fields and to-one links only");
            next.properties.push_back(found->second);
        }
        plans.push_back(std::move(next));
    }
    for (const auto& plan : plans) for (const auto& property : plan.properties) {
        if (property.kind == lattice::property_kind::link)
            require(tables.count(folded(property.target_table)) != 0, "Capture link target must also be selected");
    }
    snapshot result;
    {
        auto& db = owner->db(); read_scope scope(db);
        budget preflight, output;
        size_t total_rows = 0;
        // Existing Core objects/get_object hydrate flat rows. Preflight every
        // actual physical cell (including unselected/stale columns) before
        // those methods can allocate payloads. No layout is invented here.
        for (auto& plan : plans) {
            const auto info = db.query("PRAGMA table_info(" + quote_identifier(plan.selection.table) + ")");
            require(!info.empty() && info.size() <= 512, "Capture physical schema bound exceeded");
            std::vector<std::string> columns; bool has_id = false, has_global_id = false;
            for (const auto& column : info) {
                const auto column_name = text(column, "name");
                require(!column_name.empty() && column_name.size() <= 128, "Capture physical column name bound exceeded");
                columns.push_back(column_name); has_id |= column_name == "id"; has_global_id |= column_name == "globalId";
            }
            require(has_id && has_global_id, "Capture requires model identity columns");
            const auto ids = db.query("SELECT id FROM " + quote_identifier(plan.selection.table) + " ORDER BY id LIMIT " + std::to_string(plan.selection.max_rows + 1));
            plan.count = ids.size();
            require(plan.count <= plan.selection.max_rows && plan.count <= max_rows - total_rows, "Capture row bound exceeded");
            total_rows += plan.count;
            preflight.cells(plan.count * columns.size()); output.cells(plan.count * plan.properties.size());
            // SQLite scans the same bounded cells, but returns one aggregate
            // row instead of allocating a native result entry for every cell.
            std::string sql = "SELECT COUNT(*) AS row_count";
            for (size_t i = 0; i < columns.size(); ++i) {
                const auto length = "COALESCE(length(CAST(" + quote_identifier(columns[i]) + " AS BLOB)),0)";
                sql += ",COALESCE(MAX(" + length + "),0) AS " + quote_identifier("m" + std::to_string(i));
                sql += ",COALESCE(SUM(" + length + "),0) AS " + quote_identifier("n" + std::to_string(i));
            }
            // CASE/ELSE checks every selected scalar, including required NULLs;
            // nullable NULL is admitted without permitting other stored types.
            for (size_t i = 0; i < plan.properties.size(); ++i) {
                const auto& property = plan.properties[i];
                if (property.kind != lattice::property_kind::primitive) continue;
                const auto stored = "typeof(" + quote_identifier(property.column_name.empty() ? property.name : property.column_name) + ")";
                std::string matches = "0";
                if (property.type == lattice::column_type::integer) matches = stored + "='integer'";
                else if (property.type == lattice::column_type::real) matches = stored + " IN ('real','integer')";
                else if (property.type == lattice::column_type::text) matches = stored + "='text'";
                else if (property.type == lattice::column_type::blob) matches = stored + "='blob'";
                if (property.nullable) matches = "(" + matches + " OR " + stored + "='null')";
                sql += ",COALESCE(SUM(CASE WHEN " + matches + " THEN 0 ELSE 1 END),0) AS " + quote_identifier("t" + std::to_string(i));
            }
            sql += " FROM (SELECT * FROM " + quote_identifier(plan.selection.table) + " ORDER BY id LIMIT " + std::to_string(plan.selection.max_rows + 1) + ")";
            const auto lengths = db.query(sql);
            require(lengths.size() == 1 && integer(lengths.front(), "row_count") == static_cast<int64_t>(plan.count), "Capture row set changed during preflight");
            const auto& totals = lengths.front();
            for (size_t i = 0; i < columns.size(); ++i)
                preflight.physical_column(integer(totals, "m" + std::to_string(i)), integer(totals, "n" + std::to_string(i)));
            for (size_t i = 0; i < plan.properties.size(); ++i) {
                if (plan.properties[i].kind == lattice::property_kind::primitive)
                    require(integer(totals, "t" + std::to_string(i)) == 0, "Capture stored scalar type does not match its schema");
            }
        }
        // Validate installed junction shape before detached identity copy;
        // malformed duplicate/dangling links must refuse.
        // Keep each stored spelling: junction comparison is case-insensitive,
        // but detached identities must match the target row, not its RHS text.
        std::map<std::string, std::map<std::string, std::string>> model_identities;
        for (const auto& plan : plans) {
            const auto identities = db.query("SELECT globalId FROM " + quote_identifier(plan.selection.table) + " ORDER BY id LIMIT " + std::to_string(plan.selection.max_rows + 1));
            require(identities.size() == plan.count, "Capture identity set changed");
            auto& known = model_identities[plan.selection.table];
            for (const auto& identity : identities) {
                const auto global = text(identity, "globalId");
                require(!global.empty() && valid_utf8(global) && known.emplace(folded(global), global).second, "Invalid or duplicate captured identity");
            }
        }
        std::map<std::string, std::map<std::string, link>> captured_links;
        for (const auto& plan : plans) for (const auto& property : plan.properties) {
            if (property.kind != lattice::property_kind::link) continue;
            const auto mapping = plan.selection.table + ":" + property.name;
            const auto metadata_sizes = db.query("SELECT length(CAST(key AS BLOB)) AS bytes FROM _lattice_meta WHERE key LIKE 'internal_table:%' AND value=? LIMIT 2", {mapping});
            require(metadata_sizes.size() == 1, "Capture requires one installed to-one link mapping");
            const auto metadata_bytes = integer(metadata_sizes[0], "bytes");
            require(metadata_bytes > 0 && metadata_bytes <= 512, "Capture link metadata bound exceeded");
            const auto metadata = db.query("SELECT key FROM _lattice_meta WHERE key LIKE 'internal_table:%' AND value=? LIMIT 2", {mapping});
            const auto key = text(metadata.at(0), "key"), prefix = std::string("internal_table:");
            require(key.compare(0, prefix.size(), prefix) == 0, "Invalid capture link mapping");
            const auto junction = key.substr(prefix.size());
            // Cross-check the installed mapping against the exact current Core
            // getter rule (managed<T*>::bind_to_parent); never preflight one
            // table and let that getter read a different unchecked table.
            require(junction == "_" + plan.selection.table + "_" + property.target_table + "_" + property.name, "Unsupported capture link mapping");
            const auto info = db.query("PRAGMA table_info(" + quote_identifier(junction) + ")");
            require(info.size() == 3, "Unsupported capture junction shape");
            std::set<std::string> junction_columns;
            for (const auto& column : info) {
                junction_columns.insert(text(column, "name"));
                require(folded(text(column, "type")) == "text", "Unsupported capture junction column type");
            }
            require(junction_columns == std::set<std::string>{"globalId", "lhs", "rhs"}, "Unsupported capture junction columns");
            const auto lengths = db.query("SELECT length(CAST(lhs AS BLOB)) AS l,length(CAST(rhs AS BLOB)) AS r,length(CAST(globalId AS BLOB)) AS g,typeof(lhs) AS lt,typeof(rhs) AS rt,typeof(globalId) AS gt FROM " + quote_identifier(junction) + " LIMIT " + std::to_string(plan.selection.max_rows + 1));
            require(lengths.size() <= plan.selection.max_rows, "Capture junction row bound exceeded");
            preflight.cells(lengths.size() * 3);
            for (const auto& lengths_row : lengths) {
                for (const auto* field : {"l", "r", "g"}) {
                    const auto bytes = integer(lengths_row, field); require(bytes > 0, "Empty capture junction identity"); preflight.cell(static_cast<size_t>(bytes));
                }
                require(text(lengths_row, "lt") == "text" && text(lengths_row, "rt") == "text" && text(lengths_row, "gt") == "text", "Invalid capture junction identity type");
            }
            const auto links = db.query("SELECT lhs,rhs,globalId FROM " + quote_identifier(junction) + " LIMIT " + std::to_string(plan.selection.max_rows + 1));
            require(links.size() == lengths.size(), "Capture junction changed during preflight");
            std::set<std::string> parents, globals;
            auto& detached_links = captured_links[mapping];
            for (const auto& link_row : links) {
                const auto lhs = text(link_row, "lhs"), rhs = text(link_row, "rhs"), global = text(link_row, "globalId");
                require(valid_utf8(lhs) && valid_utf8(rhs) && valid_utf8(global), "Invalid UTF-8 capture junction identity");
                require(parents.insert(folded(lhs)).second && globals.insert(folded(global)).second, "Duplicate capture to-one link");
                require(model_identities.at(plan.selection.table).count(folded(lhs)) != 0 && model_identities.at(property.target_table).count(folded(rhs)) != 0, "Dangling capture to-one link");
                detached_links.emplace(folded(lhs), link{property.target_table, model_identities.at(property.target_table).at(folded(rhs))});
            }
        }
        result.rows.reserve(total_rows);
        for (const auto& plan : plans) {
            auto objects = owner->objects(plan.selection.table, std::nullopt, std::string("id ASC"), static_cast<int64_t>(plan.selection.max_rows + 1));
            require(lattice::last_bridge_error().empty(), "Capture Core query failed");
            require(objects.size() == plan.count, "Capture row set changed during materialization");
            for (const auto& managed : objects) {
                lattice::dynamic_object object(managed);
                // objects() already hydrated these scalar values inside this
                // same held read. The cache lives only for this detached copy.
                // A link-only model may have no scalar payload at all; do not
                // let enable_row_cache's empty-row refresh add a query for it.
                if (!managed.source.values.empty()) object.enable_row_cache();
                row copied{plan.selection.table, managed.global_id(), {}};
                require(!copied.global_id.empty(), "Capture requires a global identity"); output.string(copied.table); output.string(copied.global_id);
                for (const auto& property : plan.properties) {
                    if (property.kind == lattice::property_kind::link) {
                        // Preflight validated the entire junction in this read
                        // scope. Avoid rehydrating a target graph just for its ID.
                        const auto& links = captured_links.at(plan.selection.table + ":" + property.name);
                        const auto found = links.find(folded(copied.global_id));
                        if (found == links.end()) copied.values.emplace(property.name, nullptr);
                        else {
                            const auto& target = found->second;
                            require(target.table == property.target_table && !target.global_id.empty(), "Capture received an invalid linked identity");
                            output.string(target.table); output.string(target.global_id); copied.values.emplace(property.name, target);
                        }
                    } else if (!object.has_value(property.name)) {
                        require(property.nullable, "Capture encountered a required NULL"); copied.values.emplace(property.name, nullptr);
                    } else {
                        switch (property.type) {
                        case lattice::column_type::integer: copied.values.emplace(property.name, object.get_int(property.name)); break;
                        case lattice::column_type::real: {
                            const auto number = object.get_double(property.name); require(std::isfinite(number), "Capture REAL must be finite"); copied.values.emplace(property.name, number); break;
                        }
                        case lattice::column_type::text: {
                            auto string = object.get_string(property.name); output.string(string); copied.values.emplace(property.name, std::move(string)); break;
                        }
                        case lattice::column_type::blob: {
                            auto bytes = object.get_data(property.name); output.cell(bytes.size()); copied.values.emplace(property.name, std::move(bytes)); break;
                        }
                        }
                    }
                }
                result.rows.push_back(std::move(copied));
            }
        }
        scope.finish();
    }
    // This is now entirely detached: no row, DB, callback or native wrapper is
    // retained in the return value. Embind conversion must happen AFTER here.
    return result;
}
} // namespace lattice_js_capture
