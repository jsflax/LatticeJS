// LatticeJS Tests - Replicating Swift LatticeTests
// Note: Full integration tests require a browser environment for WASM/Workers
// These tests cover the TypeScript layer (decorators, schema building)

import { describe, it, expect, beforeEach } from 'vitest';
import 'reflect-metadata';
import {
    model,
    link,
    list,
    isModel,
    getTableName,
    buildSchemas,
    discoverModels,
} from '../src/decorators';

// ============================================================================
// Test Models (matching Swift test models)
// ============================================================================

@model
class Dog {
    name = ''
    puppies = list(Dog)
}

@model
class Person {
    name = ''
    age = 0
    friend = link(Person)
    dog = link(Dog)
}

@model
class PersonWithDogs {
    name = ''
    age = 0
    dogs = list(Dog)
}

@model
class Grandparent {
    name = ''
}

@model
class Parent {
    name = ''
    grandparent = link(Grandparent)
}

@model
class Child {
    name = ''
    parent = link(Parent)
}

@model('custom_table_name')
class CustomTableModel {
    value = ''
}

@model
class AllTypesObject {
    // String
    string = ''
    stringOpt: string | null = null

    // Bool
    bool = false
    boolOpt: boolean | null = null

    // Numbers
    int = 0
    intOpt: number | null = null
    float = 0.1  // Must be non-integer for JS to infer float
    floatOpt: number | null = null

    // Date (stored as ISO string)
    date = new Date()
    dateOpt: Date | null = null

    // Data (stored as blob)
    data = new Uint8Array()
    dataOpt: Uint8Array | null = null
}

// ============================================================================
// Decorator Tests
// ============================================================================

describe('Decorators', () => {
    describe('@model', () => {
        it('marks class as a model', () => {
            expect(isModel(Person)).toBe(true);
            expect(isModel(Dog)).toBe(true);
        });

        it('uses class name as default table name', () => {
            expect(getTableName(Person)).toBe('Person');
            expect(getTableName(Dog)).toBe('Dog');
        });

        it('allows custom table name', () => {
            expect(getTableName(CustomTableModel)).toBe('custom_table_name');
        });

        it('throws for non-model classes', () => {
            class NotAModel {}
            expect(() => getTableName(NotAModel)).toThrow();
        });
    });

    describe('list()', () => {
        it.skip('creates list properties (requires WASM)', () => {
            // This test requires WASM to be loaded first
            // The list is properly tested in List Operations tests
            const dog = new Dog();
            expect(dog.puppies).toBeDefined();
        });

        it('detects list markers in schema extraction', () => {
            const schemas = buildSchemas([Dog]);
            const dogSchema = schemas.find(s => s.tableName === 'Dog');
            const puppiesProp = dogSchema?.properties.find(p => p.name === 'puppies');
            expect(puppiesProp?.kind).toBe('list');
            expect(puppiesProp?.targetTable).toBe('Dog');
        });
    });
});

// ============================================================================
// Schema Extraction Tests
// ============================================================================

describe('Schema Extraction', () => {
    it('extracts primitive properties', () => {
        const schemas = buildSchemas([Person]);
        const personSchema = schemas.find(s => s.tableName === 'Person');

        const nameProp = personSchema?.properties.find(p => p.name === 'name');
        expect(nameProp?.kind).toBe('primitive');
        expect(nameProp?.type).toBe('string');

        const ageProp = personSchema?.properties.find(p => p.name === 'age');
        expect(ageProp?.kind).toBe('primitive');
        expect(ageProp?.type).toBe('int');
    });

    it('extracts link properties', () => {
        const schemas = buildSchemas([Person, Dog]);
        const personSchema = schemas.find(s => s.tableName === 'Person');

        const dogProp = personSchema?.properties.find(p => p.name === 'dog');
        expect(dogProp?.kind).toBe('link');
        expect(dogProp?.targetTable).toBe('Dog');
    });

    it('extracts list properties', () => {
        const schemas = buildSchemas([PersonWithDogs, Dog]);
        const personSchema = schemas.find(s => s.tableName === 'PersonWithDogs');

        const dogsProp = personSchema?.properties.find(p => p.name === 'dogs');
        expect(dogsProp?.kind).toBe('list');
        expect(dogsProp?.targetTable).toBe('Dog');
    });

    it('infers types from default values', () => {
        const schemas = buildSchemas([AllTypesObject]);
        const schema = schemas.find(s => s.tableName === 'AllTypesObject');

        expect(schema?.properties.find(p => p.name === 'string')?.type).toBe('string');
        expect(schema?.properties.find(p => p.name === 'bool')?.type).toBe('bool');
        expect(schema?.properties.find(p => p.name === 'int')?.type).toBe('int');
        expect(schema?.properties.find(p => p.name === 'float')?.type).toBe('float');
        expect(schema?.properties.find(p => p.name === 'date')?.type).toBe('date');
        expect(schema?.properties.find(p => p.name === 'data')?.type).toBe('blob');
    });

    it('handles nullable properties', () => {
        const schemas = buildSchemas([AllTypesObject]);
        const schema = schemas.find(s => s.tableName === 'AllTypesObject');

        // Non-null defaults
        expect(schema?.properties.find(p => p.name === 'string')?.nullable).toBe(false);
        // Null defaults
        expect(schema?.properties.find(p => p.name === 'stringOpt')?.nullable).toBe(true);
    });
});

// ============================================================================
// Model Discovery Tests
// ============================================================================

describe('Model Discovery', () => {
    it('discovers linked models', () => {
        const discovered = discoverModels([Person]);
        expect(discovered.has(Person)).toBe(true);
        expect(discovered.has(Dog)).toBe(true); // Discovered via Person.dog
    });

    it('discovers models through lists', () => {
        const discovered = discoverModels([PersonWithDogs]);
        expect(discovered.has(PersonWithDogs)).toBe(true);
        expect(discovered.has(Dog)).toBe(true); // Discovered via PersonWithDogs.dogs
    });

    it('discovers deeply nested models', () => {
        const discovered = discoverModels([Child]);
        expect(discovered.has(Child)).toBe(true);
        expect(discovered.has(Parent)).toBe(true);
        expect(discovered.has(Grandparent)).toBe(true);
    });

    it('handles circular references', () => {
        // Person has friend: Person (self-reference)
        const discovered = discoverModels([Person]);
        expect(discovered.has(Person)).toBe(true);
        // Should not infinite loop
    });

    it('handles recursive lists', () => {
        // Dog has puppies: list(Dog) (self-reference)
        const discovered = discoverModels([Dog]);
        expect(discovered.has(Dog)).toBe(true);
    });
});

// ============================================================================
// Schema Building Tests (matches Swift schema tests)
// ============================================================================

describe('Schema Building', () => {
    it('builds complete schema for model hierarchy', () => {
        const schemas = buildSchemas([Child]);

        expect(schemas.length).toBe(3); // Child, Parent, Grandparent
        expect(schemas.map(s => s.tableName).sort()).toEqual(['Child', 'Grandparent', 'Parent']);
    });

    it('schema matches WASM expected format', () => {
        const schemas = buildSchemas([Person, Dog]);
        const personSchema = schemas.find(s => s.tableName === 'Person');

        // Schema should be in format expected by bindings.cpp
        expect(personSchema).toEqual({
            tableName: 'Person',
            properties: expect.arrayContaining([
                expect.objectContaining({ name: 'name', type: 'string', kind: 'primitive' }),
                expect.objectContaining({ name: 'age', type: 'int', kind: 'primitive' }),
                expect.objectContaining({ name: 'friend', kind: 'link', targetTable: 'Person' }),
                expect.objectContaining({ name: 'dog', kind: 'link', targetTable: 'Dog' }),
            ]),
        });
    });
});

// ============================================================================
// Integration Tests (require browser environment)
// ============================================================================

describe.skip('Integration Tests (Browser Required)', () => {
    // These tests would use the full Lattice class with WASM
    // They need to run in a browser environment with:
    // - SharedArrayBuffer support (COOP/COEP headers)
    // - Web Workers
    // - OPFS or IndexedDB for persistence

    it('test_SimpleExample', async () => {
        // const lattice = await Lattice.open(':memory:', [Person]);
        // const person = new Person();
        // person.name = 'John';
        // person.age = 30;
        // await lattice.add(person);
        // expect(person.age).toBe(30);
    });

    it('test_ResultsQuery', async () => {
        // const lattice = await Lattice.open(':memory:', [Person]);
        // await lattice.add(Object.assign(new Person(), { name: 'John', age: 30 }));
        // await lattice.add(Object.assign(new Person(), { name: 'Jane', age: 25 }));
        // await lattice.add(Object.assign(new Person(), { name: 'Tim', age: 22 }));
        //
        // const persons = await lattice.objects(Person);
        // expect(persons.length).toBe(3);
        //
        // const filtered = await lattice.objects(Person, {
        //     where: "name = 'John' OR name = 'Jane'"
        // });
        // expect(filtered.length).toBe(2);
    });

    it('test_Link', async () => {
        // const lattice = await Lattice.open(':memory:', [Person, Dog]);
        // const person = new Person();
        // await lattice.add(person);
        // expect(person.dog).toBeNull();
        //
        // const dog = new Dog();
        // dog.name = 'max';
        // person.dog = dog;
        // expect(person.dog?.name).toBe('max');
    });

    it('test_LinkList', async () => {
        // const lattice = await Lattice.open(':memory:', [Dog]);
        // const dog = new Dog();
        // const fido = Object.assign(new Dog(), { name: 'fido' });
        // const spot = Object.assign(new Dog(), { name: 'spot' });
        // dog.puppies.push(fido, spot);
        // await lattice.add(dog);
        // expect(dog.puppies.length).toBe(2);
    });

    it('test_BulkInsert', async () => {
        // const lattice = await Lattice.open(':memory:', [Person]);
        // const people = Array.from({ length: 1000 }, (_, i) => {
        //     const p = new Person();
        //     p.age = i;
        //     return p;
        // });
        // await lattice.write(async () => {
        //     for (const p of people) await lattice.add(p);
        // });
        // const count = await lattice.count(Person);
        // expect(count).toBe(1000);
    });
});
