// Bundled with the actual HUD adapter by native-hud-interop.mjs. No owner file,
// source runner, handler, transport, mock store or inferred model is involved.
import assert from 'node:assert/strict';
import { createHUDLatticeDefinition, HUD_REGISTRY_HASH } from 'hud-native-fixture-adapter';
import { defineModels } from '../../src/explicit-models';
import { buildSchemas } from '../../src/decorators';
import { DYNAMIC_OBJECT, setWasmModule } from '../../src/storage';
import { Lattice } from '../../src/lattice';
import { assertScalar, expectedUnion, integer, mutationUnion, rowID, scalar, type Cell } from './native-hud-interop-values';

export function prepareNativeHUDInterop(manifest: any, contract: any) {
    assert.equal(manifest.formatVersion, 1);
    assert.equal(contract.formatVersion, 1);
    assert.equal(HUD_REGISTRY_HASH, manifest.registryHash, 'Generated Browser registry differs from native fixture');
    assert.equal(contract.registryHash, manifest.registryHash);
    const definition = createHUDLatticeDefinition();
    assert.deepEqual(definition, createHUDLatticeDefinition(contract.storage), 'Generated storage differs from actual native fixture');
    assert.equal(definition.models.length, 8);
    assert.equal(contract.storage.unions.length, 4);
    const models = defineModels(definition);
    const schemas = buildSchemas(Object.values(models));
    assert.equal(schemas.length, 8);
    const properties = new Map(definition.models.map((model: any) => [model.tableName, model.properties]));
    for (const family of contract.storage.unions) {
        assert.deepEqual([...manifest.unionCaseCoverage[family.name]].sort(), family.cases.map((item: any) => item.name).sort());
    }
    // Validate the entire requested mutation plan before touching a database.
    const mutations = manifest.mutations.map((mutation: any) => {
        const props = properties.get(mutation.ownerTable) as any[];
        assert.ok(props, `Unknown mutation table ${mutation.ownerTable}`);
        const property = props.find(item => item.name === mutation.property);
        assert.ok(property, `Unknown mutation property ${mutation.property}`);
        assert.notEqual(property.kind, 'link', 'Fixture does not authorize relationship mutations');
        const owner = manifest.baseline.rows.find((row: any) => row.table === mutation.ownerTable && row.globalId === mutation.ownerGlobalId);
        assert.ok(owner, 'Missing mutation owner'); rowID(owner.localId);
        assert.ok(mutation.values.length > 0);
        const values = mutation.values.map((cell: Cell) => property.kind === 'union' ? mutationUnion(cell, property) : scalar(cell, property.type));
        return { ...mutation, values };
    });
    return { definition, models, schemas, mutations };
}

export async function runNativeHUDInterop({ module, manifest, contract, filePath, inspectJunctions }: any) {
    const prepared = prepareNativeHUDInterop(manifest, contract);
    assert.equal(module.explicitUnionVersion?.(), 1, 'Missing explicit union capability');
    assert.equal(module.explicitNoHistoryVersion?.(), 1, 'Missing explicit NoHistory capability');
    setWasmModule(module);
    let native: any, primaryFailure: unknown;
    const wrappers = new Set<any>();
    const ownRaw = (value: any) => { if (value) wrappers.add(value); return value; };
    const own = (value: any) => { if (value) ownRaw(value[DYNAMIC_OBJECT]); return value; };
    const releaseRows = () => {
        const errors: unknown[] = [];
        for (const wrapper of wrappers) { try { wrapper.delete(); } catch (error) { errors.push(error); } }
        wrappers.clear();
        if (errors.length) throw new AggregateError(errors, 'Native fixture wrapper cleanup failed');
    };
    const reports: any[] = [];
    try {
        native = new module.Lattice(filePath, prepared.schemas);
        assert.equal(typeof native.objectIdentities, 'function');
        // Real public query/codec methods, attached to the real native handle.
        // This excludes the Vite public-open loader and browser OPFS lifecycle.
        const db = Object.assign(Object.create(Lattice.prototype), { db: native }) as Lattice;
        const verify = async (snapshot: any, stage: string) => {
            let typedCells = 0, physicalCells = 0, unionValues = 0;
            const typedByIdentity = new Map<string, any>();
            for (const model of prepared.definition.models) {
                const rows = (await db.objectsArray((prepared.models as any)[model.tableName])).map(own);
                const expected = snapshot.rows.filter((row: any) => row.table === model.tableName);
                assert.ok(expected.length > 0, `Unseeded model ${model.tableName}`);
                assert.equal(rows.length, expected.length, `${stage} ${model.tableName} row count`);
                for (const row of rows) {
                    const reference = expected.find((item: any) => item.globalId === row.globalId);
                    assert.ok(reference, `Unexpected ${model.tableName} identity ${row.globalId}`);
                    assert.equal(row.id, rowID(reference.localId));
                    typedByIdentity.set(`${model.tableName}|${row.globalId}`, row);
                    assert.deepEqual(Object.keys(reference.fields).sort(), model.properties.map((p: any) => p.name).sort());
                    for (const prop of model.properties) {
                        const label = `${stage} ${model.tableName}.${prop.name} (${row.globalId})`;
                        const cell = reference.fields[prop.name], value = row[prop.name];
                        if (prop.kind === 'union') {
                            assert.deepEqual(value, expectedUnion(snapshot, reference, prop), label); ++unionValues;
                            assert.equal(row[DYNAMIC_OBJECT].getString(prop.name), cell.value, `${label} physical FK`);
                        } else if (prop.kind === 'link') {
                            if (cell.kind === 'null') assert.equal(value, null, label);
                            else {
                                own(value); assert.equal(cell.kind, 'link'); assert.equal(prop.targetTable, cell.table);
                                assert.equal(value.id, rowID(cell.localId), label); assert.equal(value.globalId, cell.globalId, label);
                            }
                        } else assertScalar(value, cell, prop.type, label);
                        ++typedCells;
                    }
                }
            }
            // Primary model rows use actual native wrappers. Generic union-side
            // getters cannot quote their reserved `case` column in this baseline;
            // inspect these and id-less junctions through checked read-only SQLite.
            // Typed public union codecs and parent reads above remain independent.
            const tables = prepared.definition.models.map((model: any) => model.tableName);
            const sideTables = [...contract.storage.unionTables, ...contract.storage.linkTables];
            assert.deepEqual([...new Set(snapshot.rows.map((row: any) => row.table))].sort(),
                [...tables, ...sideTables].sort());
            for (const table of tables) {
                const expected = snapshot.rows.filter((row: any) => row.table === table);
                const identities = native.objectIdentities(table, null, null, null, null, null, null);
                assert.equal(identities.length, expected.length, `${stage} physical ${table} row count`);
                for (const identity of identities) {
                    const reference = expected.find((row: any) => row.globalId ? row.globalId === identity.globalId : integer(row.localId) === identity.id);
                    assert.ok(reference, `Unexpected physical identity in ${table}`);
                    assert.equal(identity.id, integer(reference.localId));
                    const object = ownRaw(native.findObject(table, rowID(reference.localId)));
                    assert.equal(object.isValid(), true);
                    for (const [name, rawCell] of Object.entries(reference.fields)) {
                        const cell = rawCell as Cell, label = `${stage} physical ${table}.${name}`;
                        assert.equal(object.hasValue(name), cell.kind !== 'null', `${label} presence`);
                        if (cell.kind === 'null') continue;
                        if (cell.kind === 'link') {
                            const linked = ownRaw(object.getObject(name)); assert.equal(linked.isValid(), true);
                            assert.equal(linked.getInt('id'), integer(cell.localId), label);
                            assert.equal(linked.getString('globalId'), cell.globalId, label);
                        } else if (cell.kind === 'unionRef') assert.equal(object.getString(name), cell.value, label);
                        else {
                            const type = cell.kind === 'int64' ? 'int' : ['float64', 'unixSeconds'].includes(cell.kind) ? 'float' : 'string';
                            const value = type === 'int' ? object.getInt(name) : type === 'float' ? object.getDouble(name) : object.getString(name);
                            assertScalar(value, cell, type, label);
                        }
                        ++physicalCells;
                    }
                }
            }
            assert.equal(unionValues, snapshot.logicalUnions.length);
            assert.equal(typeof inspectJunctions, "function", "Physical side tables require test-only inspection");
            native.walCheckpoint();
            const sideTableInspection = await inspectJunctions({ stage, snapshot, tables: sideTables, filePath });
            reports.push({ stage, modelTables: 8, unionFamilies: 4, nativeManagedTables: tables.length,
                rows: snapshot.rows.length, typedCells, physicalCells, unionValues, sideTableInspection, exactPhysicalRows: true });
            return typedByIdentity;
        };
        const rows = await verify(manifest.baseline, 'baseline');
        native.beginWrite();
        for (const mutation of prepared.mutations) {
            const row = rows.get(`${mutation.ownerTable}|${mutation.ownerGlobalId}`);
            assert.ok(row);
            for (const value of mutation.values) row[mutation.property] = value;
        }
        native.commitWrite();
        releaseRows();
        await verify(manifest.expectedReturned, 'returned');
        native.walCheckpoint();
        return { reports, mutations: prepared.mutations.length,
            unionCodableJSONParsedForEquality: false, rowIdentityPolicy: 'checked safe number; value Int64 remains BigInt',
            descriptorsUnmodified: true, noHistoryLiveValuesChecked: true,
            auditHistoryOracle: 'pending separate Swift read-only verifier', publicOpenLoaderCovered: false,
            browserOPFSCovered: false, liveSyncCovered: false, installedRuntimeParity: false };
    } catch (error) { primaryFailure = error; throw error; }
    finally {
        const cleanupErrors: unknown[] = [];
        try { releaseRows(); } catch (error) { cleanupErrors.push(error); }
        setWasmModule(null);
        if (native) {
            try { assert.equal(native.releaseStorage(), 'closed', 'Native store was not fully closed'); }
            catch (error) { cleanupErrors.push(error); }
            finally { try { native.delete(); } catch (error) { cleanupErrors.push(error); } }
        }
        if (cleanupErrors.length) throw new AggregateError(primaryFailure ? [primaryFailure, ...cleanupErrors] : cleanupErrors,
            `Native fixture failed cleanup${primaryFailure ? ` after: ${String(primaryFailure)}` : ''}`);
    }
}
