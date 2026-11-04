/** Legacy object APIs are intentionally narrower than opaque native audit frames.
 * Refuse unsafe numbers before JSON.parse can silently round Int64 wire tokens. */
export function parseSafeAuditJSON(json: string): any {
    let quoted = false, escaped = false;
    for (let i = 0; i < json.length; ++i) {
        const ch = json[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') quoted = false;
            continue;
        }
        if (ch === '"') { quoted = true; continue; }
        if (ch === '-' || (ch >= '0' && ch <= '9')) {
            const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(json.slice(i))?.[0];
            if (!token) continue; // JSON.parse supplies the syntax error.
            const value = Number(token);
            if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
                throw new RangeError('Unsafe audit number; use opaque audit frames for exact Int64 values');
            }
            i += token.length - 1;
        }
    }
    return JSON.parse(json);
}

/** Refuse already materialized unsafe values before any legacy retransmission. */
export function assertSafeAuditValue(value: unknown, seen = new Set<object>(), depth = 0): void {
    if (depth > 128) throw new RangeError('Audit value is too deeply nested');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
            throw new RangeError('Unsafe audit number; use opaque audit frames for exact Int64 values');
        }
        return;
    }
    if (typeof value !== 'object') throw new TypeError('Legacy audit values must be JSON values; use opaque audit frames');
    if (seen.has(value)) throw new TypeError('Cyclic audit value');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new TypeError('Audit value must be a plain JSON record');
    }
    seen.add(value);
    try {
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
            if (Array.isArray(value) && key === 'length') continue;
            if (!('value' in descriptor)) throw new TypeError('Audit accessors are not supported');
            assertSafeAuditValue(descriptor.value, seen, depth + 1);
        }
    } finally { seen.delete(value); }
}
