// crypto.randomUUID exists only in secure contexts (https / localhost).
// Pages served over plain http from a LAN IP — a phone pointed at a dev
// server — get `crypto.randomUUID is not a function` mid-boot and die.
// crypto.getRandomValues has no such restriction, so fall back to a manual
// RFC 4122 v4 assembly. Lowercase hex, matching the wasm side's convention.
export function safeRandomUUID(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
