// Bundled with the actual HUD adapter by native-hud-interop.mjs. No owner file,
// source runner, handler, transport, mock store or inferred model is involved.
import assert from 'node:assert/strict';
import { createHUDLatticeDefinition, HUD_REGISTRY_HASH } from 'hud-native-fixture-adapter';
import { defineModels } from '../../src/explicit-models';
import { buildSchemas } from '../../src/decorators';
import { DYNAMIC_OBJECT, setWasmModule } from '../../src/storage';
import { Lattice } from '../../src/lattice';
import { assertScalar, expectedUnion, integer, mutationUnion, rowID, scalar, type Cell } from './native-hud-interop-values';

// Fixture write policy only; all model/property/type declarations still come from
// the actual native export through createHUDLatticeDefinition/defineModels.
const immutableExpandedTables = ['HUDAsset', 'HUDAssetChunk', 'HUDSVGResourcePackage',
    'HUDSVGResourceBindingRow', 'HUDSVGFontVariationRow', 'HUDNativeViewTopicRow', 'HUDNativeViewPayloadRow'];
const referenceExpandedTables = ['HUDAssetAttachment', 'HUDNativeViewBindingRow'];
const expandedTables = [...immutableExpandedTables, ...referenceExpandedTables];

function expandedFixtureCoverage(manifest: any, contract: any): { models: number; nullableProperties: number } {
    const models = contract.storage.models.filter((model: any) => expandedTables.includes(model.name));
    assert.deepEqual(models.map((model: any) => model.name).sort(), [...expandedTables].sort());
    let nullableProperties = 0;
    for (const model of models) {
        const rows = manifest.baseline.rows.filter((row: any) => row.table === model.name);
        assert.ok(rows.length > 0, `Unseeded expanded model ${model.name}`);
        for (const property of model.properties.filter((prop: any) => prop.logicalType.nullable)) {
            const cells = rows.map((row: any) => row.fields[property.name]);
            assert.ok(cells.every((cell: any) => cell && typeof cell.kind === 'string'), `Missing ${model.name}.${property.name}`);
            assert.ok(cells.some((cell: Cell) => cell.kind === 'null') && cells.some((cell: Cell) => cell.kind !== 'null'),
                `Native fixture must cover both nullable states for ${model.name}.${property.name}`);
            ++nullableProperties;
        }
    }
    assert.equal(nullableProperties, 25, 'Format2 expanded-model nullable coverage changed');
    const expandedMutations = manifest.mutations.filter((item: any) => expandedTables.includes(item.ownerTable));
    assert.equal(manifest.mutations.length, 13, 'Retain the original eleven mutations and exactly two reference tombstones');
    assert.equal(expandedMutations.length, 2);
    assert.deepEqual(expandedMutations.map((item: any) => item.ownerTable).sort(), [...referenceExpandedTables].sort());
    for (const mutation of expandedMutations) {
        assert.equal(mutation.property, 'deletedAt', 'Expanded rows only authorize reference tombstones');
        assert.equal(mutation.values.length, 1);
        assert.equal(mutation.values[0].kind, 'unixSeconds');
        scalar(mutation.values[0], 'date');
        const before = manifest.baseline.rows.find((row: any) => row.table === mutation.ownerTable && row.globalId === mutation.ownerGlobalId);
        const after = manifest.expectedReturned.rows.find((row: any) => row.table === mutation.ownerTable && row.globalId === mutation.ownerGlobalId);
        assert.ok(before && after, 'Reference tombstone requires an existing native identity');
        assert.equal(before.fields.deletedAt.kind, 'null', 'Do not mutate an already-retired reference');
        assert.deepEqual(after.fields.deletedAt, mutation.values[0], 'Reference oracle does not match its planned tombstone');
    }
    for (const table of expandedTables) {
        const before = manifest.baseline.rows.filter((row: any) => row.table === table);
        const after = manifest.expectedReturned.rows.filter((row: any) => row.table === table);
        assert.equal(after.length, before.length, `Expanded table cannot add/remove rows: ${table}`);
        assert.equal(new Set(before.map((row: any) => row.globalId)).size, before.length, `Duplicate baseline identity: ${table}`);
        assert.equal(new Set(after.map((row: any) => row.globalId)).size, after.length, `Duplicate returned identity: ${table}`);
        for (const old of before) {
            const changed = after.find((row: any) => row.globalId === old.globalId);
            assert.ok(changed, `Expanded identity disappeared: ${table}`);
            const mutation = expandedMutations.find((item: any) => item.ownerTable === table && item.ownerGlobalId === old.globalId);
            assert.deepEqual(changed, mutation ? { ...old, fields: { ...old.fields, deletedAt: mutation.values[0] } } : old,
                `Native oracle changes expanded row outside its allowed tombstone: ${table}`);
        }
    }
    // These are native-reference audit expectations, not observations of the
    // Wasm audit. The existing separate Swift return verifier checks that audit.
    assert.ok(Array.isArray(manifest.nativeMutationAudit));
    const expandedAudit = manifest.nativeMutationAudit.filter((entry: any) => expandedTables.includes(entry.table));
    assert.equal(expandedAudit.length, 2);
    assert.deepEqual(expandedAudit.map((entry: any) => entry.table).sort(), [...referenceExpandedTables].sort());
    for (const entry of expandedAudit) {
        assert.equal(entry.operation, 'UPDATE');
        assert.deepEqual(entry.names, ['deletedAt']);
    }
    return { models: models.length, nullableProperties };
}

export function prepareNativeHUDInterop(manifest: any, contract: any) {
    assert.equal(manifest.formatVersion, 2, 'Format1 evidence requires its preserved original consumer');
    assert.equal(contract.formatVersion, 1);
    assert.equal(HUD_REGISTRY_HASH, manifest.registryHash, 'Generated Browser registry differs from native fixture');
    assert.equal(contract.registryHash, manifest.registryHash);
    const definition = createHUDLatticeDefinition();
    assert.deepEqual(definition, createHUDLatticeDefinition(contract.storage), 'Generated storage differs from actual native fixture');
    assert.equal(definition.models.length, 17);
    assert.equal(contract.storage.unions.length, 4);
    const expandedCoverage = expandedFixtureCoverage(manifest, contract);
    const models = defineModels(definition);
    const schemas = buildSchemas(Object.values(models));
    assert.equal(schemas.length, 17);
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
    return { definition, models, schemas, mutations, expandedCoverage };
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
            let typedCells = 0, physicalCells = 0, unionValues = 0, blobCells = 0;
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
                        } else {
                            assertScalar(value, cell, prop.type, label);
                            if (cell.kind === 'blob') ++blobCells;
                        }
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
                            const type = cell.kind === 'blob' ? 'blob' : cell.kind === 'int64' ? 'int' : ['float64', 'unixSeconds'].includes(cell.kind) ? 'float' : 'string';
                            const value = type === 'blob' ? object.getData(name) : type === 'int' ? object.getInt(name) : type === 'float' ? object.getDouble(name) : object.getString(name);
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
            assert.ok(blobCells > 0, 'Expanded fixture must exercise actual typed BLOB cells');
            reports.push({ stage, modelTables: prepared.definition.models.length, unionFamilies: contract.storage.unions.length,
                nativeManagedTables: tables.length, rows: snapshot.rows.length, typedCells, physicalCells, unionValues,
                blobCells, sideTableInspection, exactPhysicalRows: true });
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
            fixtureFormat: 2, expandedCoverage: prepared.expandedCoverage,
            expandedImmutableTables: immutableExpandedTables, expandedReferenceTombstones: 2,
            blobEncoding: 'lowercase hex; exact Uint8Array bytes; empty BLOB is distinct from NULL',
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
