// LatticeJS Tests - Replicating Swift LatticeTests
// Note: Full integration tests require a browser environment for WASM/Workers
// These tests cover the TypeScript layer (decorators, schema building)

import { describe, it, expect, beforeEach } from 'vitest';
import 'reflect-metadata';
import {
    model,
    link,
    list,
    indexed,
    fullText,
    vector,
    embedded,
    enumValue,
    unique,
    compoundUnique,
    isModel,
    getTableName,
    buildSchemas,
    discoverModels,
} from '../src/decorators';
import { QueryNode, createQueryProxy } from '../src/query';

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

    it('extracts indexed property flag', () => {
        @model
        class IndexedModel {
            email = indexed('')
            name = ''
        }
        const schemas = buildSchemas([IndexedModel]);
        const schema = schemas.find(s => s.tableName === 'IndexedModel');
        expect(schema?.properties.find(p => p.name === 'email')?.isIndexed).toBe(true);
        expect(schema?.properties.find(p => p.name === 'email')?.type).toBe('string');
        expect(schema?.properties.find(p => p.name === 'name')?.isIndexed).toBeFalsy();
    });

    it('extracts fullText property flag', () => {
        @model
        class FTSModel {
            content = fullText('')
        }
        const schemas = buildSchemas([FTSModel]);
        const schema = schemas.find(s => s.tableName === 'FTSModel');
        expect(schema?.properties.find(p => p.name === 'content')?.isFullText).toBe(true);
        expect(schema?.properties.find(p => p.name === 'content')?.type).toBe('string');
    });

    it('extracts vector property as blob with isVector flag', () => {
        @model
        class VecModel {
            embedding = vector(384)
        }
        const schemas = buildSchemas([VecModel]);
        const schema = schemas.find(s => s.tableName === 'VecModel');
        const embeddingProp = schema?.properties.find(p => p.name === 'embedding');
        expect(embeddingProp?.type).toBe('blob');
        expect(embeddingProp?.isVector).toBe(true);
    });

    it('extracts embedded model as string type', () => {
        class Address {
            street = '';
            city = '';
        }
        @model
        class EmbeddedModel {
            address = embedded(Address)
        }
        const schemas = buildSchemas([EmbeddedModel]);
        const schema = schemas.find(s => s.tableName === 'EmbeddedModel');
        const addrProp = schema?.properties.find(p => p.name === 'address');
        expect(addrProp?.type).toBe('string');
        expect(addrProp?.nullable).toBe(true);
    });

    it('extracts string enum as string type', () => {
        enum Status { Active = 'active', Inactive = 'inactive' }
        @model
        class EnumModel {
            status = enumValue(Status, Status.Active)
        }
        const schemas = buildSchemas([EnumModel]);
        const schema = schemas.find(s => s.tableName === 'EnumModel');
        const statusProp = schema?.properties.find(p => p.name === 'status');
        expect(statusProp?.type).toBe('string');
    });

    it('extracts numeric enum as int type', () => {
        enum Priority { Low = 0, Medium = 1, High = 2 }
        @model
        class NumEnumModel {
            priority = enumValue(Priority, Priority.Medium)
        }
        const schemas = buildSchemas([NumEnumModel]);
        const schema = schemas.find(s => s.tableName === 'NumEnumModel');
        const priorityProp = schema?.properties.find(p => p.name === 'priority');
        expect(priorityProp?.type).toBe('int');
    });

    it('extracts unique constraints', () => {
        @model
        class UniqueModel {
            @unique()
            email = ''
            name = ''
        }
        const schemas = buildSchemas([UniqueModel]);
        const schema = schemas.find(s => s.tableName === 'UniqueModel');
        expect(schema?.constraints).toBeDefined();
        expect(schema?.constraints?.length).toBe(1);
        expect(schema?.constraints?.[0].columns).toEqual(['email']);
    });

    it('extracts compound unique constraints', () => {
        @compoundUnique(['firstName', 'lastName'])
        @model
        class CompoundModel {
            firstName = ''
            lastName = ''
        }
        const schemas = buildSchemas([CompoundModel]);
        const schema = schemas.find(s => s.tableName === 'CompoundModel');
        expect(schema?.constraints).toBeDefined();
        expect(schema?.constraints?.length).toBe(1);
        expect(schema?.constraints?.[0].columns).toEqual(['firstName', 'lastName']);
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
// Query Builder Tests (no WASM needed)
// ============================================================================

describe('Query Builder', () => {
    interface TestModel {
        name: string;
        age: number;
        email: string;
        active: boolean;
        createdAt: Date;
    }

    it('generates eq SQL', () => {
        const q = createQueryProxy<TestModel>();
        expect(q.name.eq('John').toSQL()).toBe("name = 'John'");
        expect(q.age.eq(30).toSQL()).toBe("age = 30");
    });

    it('generates neq SQL', () => {
        const q = createQueryProxy<TestModel>();
        expect(q.name.neq('John').toSQL()).toBe("name != 'John'");
    });

    it('generates gt/gte/lt/lte SQL', () => {
        const q = createQueryProxy<TestModel>();
        expect(q.age.gt(18).toSQL()).toBe('age > 18');
        expect(q.age.gte(18).toSQL()).toBe('age >= 18');
        expect(q.age.lt(65).toSQL()).toBe('age < 65');
        expect(q.age.lte(65).toSQL()).toBe('age <= 65');
    });

    it('generates contains/startsWith/endsWith SQL', () => {
        const q = createQueryProxy<TestModel>();
        expect(q.name.contains('oh').toSQL()).toBe("name LIKE '%oh%'");
        expect(q.name.startsWith('Jo').toSQL()).toBe("name LIKE 'Jo%'");
        expect(q.name.endsWith('hn').toSQL()).toBe("name LIKE '%hn'");
    });

    it('generates like SQL', () => {
        const q = createQueryProxy<TestModel>();
        expect(q.name.like('J%n').toSQL()).toBe("name LIKE 'J%n'");
    });

    it('generates in SQL', () => {
        const q = createQueryProxy<TestModel>();
        expect(q.name.in(['John', 'Jane']).toSQL()).toBe("name IN ('John', 'Jane')");
        expect(q.age.in([20, 30, 40]).toSQL()).toBe('age IN (20, 30, 40)');
    });

    it('generates between SQL', () => {
        const q = createQueryProxy<TestModel>();
        expect(q.age.between(18, 65).toSQL()).toBe('age BETWEEN 18 AND 65');
    });

    it('generates isNull/isNotNull SQL', () => {
        const q = createQueryProxy<TestModel>();
        expect(q.email.isNull().toSQL()).toBe('email IS NULL');
        expect(q.email.isNotNull().toSQL()).toBe('email IS NOT NULL');
    });

    it('generates eq(null) as IS NULL', () => {
        const q = createQueryProxy<TestModel>();
        expect(q.email.eq(null).toSQL()).toBe('email IS NULL');
        expect(q.email.neq(null).toSQL()).toBe('email IS NOT NULL');
    });

    it('generates and/or combinations', () => {
        const q = createQueryProxy<TestModel>();
        const node = q.age.gte(18).and(q.name.startsWith('J'));
        expect(node.toSQL()).toBe("(age >= 18) AND (name LIKE 'J%')");
    });

    it('generates complex nested queries', () => {
        const q = createQueryProxy<TestModel>();
        const node = q.age.gte(18).and(
            q.name.eq('John').or(q.name.eq('Jane'))
        );
        expect(node.toSQL()).toBe("(age >= 18) AND ((name = 'John') OR (name = 'Jane'))");
    });

    it('generates not() SQL', () => {
        const q = createQueryProxy<TestModel>();
        const node = q.active.eq(true).not();
        expect(node.toSQL()).toBe('NOT (active = 1)');
    });

    it('escapes single quotes in strings', () => {
        const q = createQueryProxy<TestModel>();
        expect(q.name.eq("O'Brien").toSQL()).toBe("name = 'O''Brien'");
    });

    it('handles boolean values', () => {
        const q = createQueryProxy<TestModel>();
        expect(q.active.eq(true).toSQL()).toBe('active = 1');
        expect(q.active.eq(false).toSQL()).toBe('active = 0');
    });
});

// ============================================================================
// Integration Tests (require browser environment)
// ============================================================================

describe.skip('Integration Tests (Browser Required)', () => {
    it('test_SimpleExample', async () => {});
    it('test_ResultsQuery', async () => {});
    it('test_Link', async () => {});
    it('test_LinkList', async () => {});
    it('test_BulkInsert', async () => {});
});
