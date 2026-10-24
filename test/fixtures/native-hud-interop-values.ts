// Exact native fixture cells. This is test transport, not another HUD schema.
import assert from 'node:assert/strict';

export interface Cell {
    kind: string; value?: string; bits?: string; table?: string; globalId?: string; localId?: string;
}
export function integer(text: unknown): bigint {
    assert.equal(typeof text, 'string', 'Native integer must remain decimal text');
    assert.match(text as string, /^(?:0|-?[1-9][0-9]*)$/);
    const result = BigInt(text as string);
    assert.ok(result >= -(1n << 63n) && result < (1n << 63n), 'Outside signed Int64');
    return result;
}
export function rowID(text: unknown): number {
    const value = integer(text);
    assert.ok(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), 'Unsafe native row identity');
    return Number(value);
}
export function doubleBits(value: number): string {
    assert.equal(typeof value, 'number');
    assert.ok(Number.isFinite(value), 'Nonfinite fixture value');
    const buffer = new ArrayBuffer(8), view = new DataView(buffer);
    view.setFloat64(0, value, false);
    return view.getBigUint64(0, false).toString(16).padStart(16, '0');
}
export function fromDoubleBits(bits: unknown): number {
    assert.equal(typeof bits, 'string');
    assert.match(bits as string, /^[0-9a-f]{16}$/);
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(`0x${bits}`), false);
    const value = view.getFloat64(0, false);
    assert.ok(Number.isFinite(value), 'Nonfinite fixture value');
    return value;
}
export function scalar(cell: Cell, type: string): unknown {
    if (cell.kind === 'null') return null;
    if (cell.kind === 'int64') {
        const value = integer(cell.value);
        if (type === 'bool') { assert.ok(value === 0n || value === 1n); return value === 1n; }
        assert.equal(type, 'int'); return value;
    }
    if (cell.kind === 'float64' || cell.kind === 'unixSeconds') {
        assert.ok(type === 'float' || type === 'date'); return fromDoubleBits(cell.bits);
    }
    assert.ok(cell.kind === 'text' || cell.kind === 'embeddedJSON', `Unsupported fixture cell ${cell.kind}`);
    assert.equal(type, 'string'); assert.equal(typeof cell.value, 'string');
    return cell.value;
}
export function assertScalar(actual: unknown, cell: Cell, type: string, label: string): void {
    const expected = scalar(cell, type);
    if (typeof expected === 'number') assert.equal(doubleBits(actual as number), cell.bits, label);
    else assert.equal(actual, expected, label);
}

// Native mutation JSON currently contains only bare cases or string fields.
// Refuse integer-bearing mutations instead of parsing an Int64 token through
// Number. Existing wide union equality uses physical cells, never this decoder.
export function mutationUnion(cell: Cell, property: any): unknown {
    assert.equal(cell.kind, 'unionCodableJSON');
    assert.equal(typeof cell.value, 'string');
    const outer = JSON.parse(cell.value!);
    assert.ok(outer && typeof outer === 'object' && !Array.isArray(outer));
    const names = Object.keys(outer);
    assert.equal(names.length, 1);
    const name = names[0], definition = property.unionCases.find((item: any) => item.name === name);
    assert.ok(definition, `Unknown mutation union case ${name}`);
    assert.ok(definition.values.every((field: any) => field.type === 'string'), 'Integer union mutations require an exact JSON decoder');
    const value = outer[name];
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    const expectedKeys = definition.values.map((field: any, index: number) => field.paramName || `_${index}`);
    assert.deepEqual(Object.keys(value).sort(), [...expectedKeys].sort());
    for (const key of expectedKeys) assert.equal(typeof value[key], 'string');
    return { case: name, fields: value };
}

export function expectedUnion(snapshot: any, owner: any, property: any): unknown {
    const reference = owner.fields[property.name];
    if (reference.kind === 'null') { assert.equal(property.logicalNullable, true); return null; }
    assert.equal(reference.kind, 'unionRef');
    assert.equal(reference.table, property.targetTable);
    const physical = snapshot.rows.find((row: any) => row.table === property.targetTable && row.globalId === reference.value);
    assert.ok(physical, 'Missing physical union row');
    const caseName = physical.fields.case.value;
    const definition = property.unionCases.find((item: any) => item.name === caseName);
    assert.ok(definition, `Unknown physical case ${caseName}`);
    const logical = snapshot.logicalUnions.find((item: any) => item.ownerTable === owner.table &&
        item.ownerGlobalId === owner.globalId && item.property === property.name);
    assert.ok(logical, 'Missing native logical union oracle');
    assert.equal(logical.caseName, caseName);
    // codableJSON is preserved in manifest/receipt; it is never JSON-parsed.
    const fields: Record<string, unknown> = {};
    for (const [index, field] of definition.values.entries()) {
        const key = field.paramName || `_${index}`;
        const column = definition.values.length === 1 && field.paramName === '' ? caseName : `${caseName}__${key}`;
        fields[key] = scalar(physical.fields[column], field.type);
    }
    for (const other of property.unionCases) if (other.name !== caseName) {
        for (const [index, field] of other.values.entries()) {
            const column = other.values.length === 1 && field.paramName === '' ? other.name : `${other.name}__${field.paramName || `_${index}`}`;
            assert.equal(physical.fields[column].kind, 'null', 'Inactive union field is not null in native oracle');
        }
    }
    return { case: caseName, fields };
}
