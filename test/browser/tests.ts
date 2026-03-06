// Browser integration tests for LatticeJS
import 'reflect-metadata';
import { model, link, list, nullable, indexed, fullText, vector, embedded, enumValue, buildSchemas, Lattice } from '../../src/index';

// ============================================================================
// Test Models
// ============================================================================

@model
class Dog {
    name = '';
    puppies = list(Dog);
}

@model
class Person {
    name = '';
    age = 0;
    dog = link(Dog);
}

@model
class Event {
    title = '';
    createdAt: Date = new Date();
    updatedAt = nullable(Date);
}

// ============================================================================
// Test Framework
// ============================================================================

interface TestResult {
    name: string;
    status: 'pass' | 'fail' | 'skip';
    error?: Error;
}

const results: TestResult[] = [];
let testsDiv: HTMLElement;
let summaryDiv: HTMLElement;

function updateSummary() {
    const passed = results.filter(r => r.status === 'pass').length;
    const failed = results.filter(r => r.status === 'fail').length;
    const skipped = results.filter(r => r.status === 'skip').length;
    summaryDiv.innerHTML = `<strong>Passed: ${passed}</strong> | Failed: ${failed} | Skipped: ${skipped}`;
    summaryDiv.style.background = failed > 0 ? '#4d1a1a' : '#1a4d1a';
}

function renderTest(result: TestResult & { errorText?: string }) {
    const div = document.createElement('div');
    div.className = `test ${result.status}`;

    const icon = result.status === 'pass' ? '✓' : result.status === 'fail' ? '✗' : '○';
    div.innerHTML = `${icon} ${result.name}`;

    if (result.errorText) {
        const pre = document.createElement('pre');
        pre.textContent = result.errorText;
        div.appendChild(pre);
    }

    testsDiv.appendChild(div);
}

async function test(name: string, fn: () => Promise<void>) {
    const runningDiv = document.createElement('div');
    runningDiv.className = 'test running';
    runningDiv.textContent = `⏳ ${name}`;
    testsDiv.appendChild(runningDiv);

    try {
        await fn();
        runningDiv.remove();
        const result = { name, status: 'pass' as const };
        results.push(result);
        renderTest(result);
    } catch (err: unknown) {
        runningDiv.remove();
        let errorText: string;
        if (err instanceof Error) {
            errorText = `${err.message}\n${err.stack}`;
        } else if (typeof err === 'string') {
            errorText = err;
        } else {
            errorText = JSON.stringify(err, null, 2);
        }
        const result = { name, status: 'fail' as const, errorText };
        results.push(result);
        renderTest(result);
        console.error(name, err);
    }
    updateSummary();
}

function skip(name: string, reason?: string) {
    const result: TestResult = { name: reason ? `${name} - ${reason}` : name, status: 'skip' };
    results.push(result);
    renderTest(result);
    updateSummary();
}

// Convert value to string, handling BigInt
function stringify(val: unknown): string {
    if (typeof val === 'bigint') return val.toString();
    if (val === undefined) return 'undefined';
    if (val === null) return 'null';
    return JSON.stringify(val);
}

// Generate unique DB path for each test
let testCounter = 0;
function uniqueDbPath(): string {
    return `:memory:${++testCounter}`;
}

function expect<T>(value: T) {
    return {
        toBe(expected: T) {
            // Handle BigInt/number comparison (30n == 30)
            if (typeof value === 'bigint' && typeof expected === 'number') {
                if (value !== BigInt(expected)) {
                    throw new Error(`Expected ${stringify(expected)} but got ${stringify(value)}`);
                }
                return;
            }
            if (typeof value === 'number' && typeof expected === 'bigint') {
                if (BigInt(value) !== expected) {
                    throw new Error(`Expected ${stringify(expected)} but got ${stringify(value)}`);
                }
                return;
            }
            if (value !== expected) {
                throw new Error(`Expected ${stringify(expected)} but got ${stringify(value)}`);
            }
        },
        toEqual(expected: T) {
            if (stringify(value) !== stringify(expected)) {
                throw new Error(`Expected ${stringify(expected)} but got ${stringify(value)}`);
            }
        },
        toBeNull() {
            if (value !== null) {
                throw new Error(`Expected null but got ${stringify(value)}`);
            }
        },
        toBeDefined() {
            if (value === undefined) {
                throw new Error(`Expected defined but got undefined`);
            }
        },
        toBeGreaterThan(expected: number) {
            if (!(value as unknown as number > expected)) {
                throw new Error(`Expected ${value} > ${expected}`);
            }
        }
    };
}

// ============================================================================
// Tests
// ============================================================================

async function runTests() {
    testsDiv = document.getElementById('tests')!;
    summaryDiv = document.getElementById('summary')!;
    summaryDiv.textContent = 'Running tests...';

    // Schema tests (don't need WASM)
    await test('buildSchemas creates correct schema', async () => {
        const schemas = buildSchemas([Person, Dog]);
        expect(schemas.length).toBe(2);

        const personSchema = schemas.find(s => s.tableName === 'Person');
        expect(personSchema).toBeDefined();
        expect(personSchema!.properties.find(p => p.name === 'name')?.type).toBe('string');
        expect(personSchema!.properties.find(p => p.name === 'age')?.type).toBe('int');
        expect(personSchema!.properties.find(p => p.name === 'dog')?.kind).toBe('link');
    });

    await test('link() and list() create correct markers', async () => {
        const schemas = buildSchemas([Dog]);
        const dogSchema = schemas.find(s => s.tableName === 'Dog');
        expect(dogSchema!.properties.find(p => p.name === 'puppies')?.kind).toBe('list');
        expect(dogSchema!.properties.find(p => p.name === 'puppies')?.targetTable).toBe('Dog');
    });

    // WASM integration tests
    let wasmAvailable = false;
    try {
        const response = await fetch('/wasm/build/lattice.js');
        wasmAvailable = response.ok;
    } catch {
        wasmAvailable = false;
    }

    if (!wasmAvailable) {
        skip('test_SimpleExample', 'WASM not built');
        skip('test_ResultsQuery', 'WASM not built');
        skip('test_Count', 'WASM not built');
        skip('test_BulkInsert', 'WASM not built');
        skip('test_Remove', 'WASM not built');
        skip('test_RemoveQueriedObject', 'WASM not built');
        return;
    }

    await test('test_SimpleExample', async () => {
        console.log('Opening database...');
        const lattice = await Lattice.open(uniqueDbPath(), [Person, Dog]);
        console.log('Database opened, creating person...');

        const person = new Person();
        person.name = 'John';
        person.age = 30;
        console.log('Adding person...', person);

        await lattice.add(person);
        console.log('Person added, id:', person.id);
        expect(person.id).toBeDefined();
        expect(person.age).toBe(30);

        console.log('Finding person...');
        const found = await lattice.find(Person, person.id!);
        console.log('Found:', found);
        expect(found?.name).toBe('John');
        expect(found?.age).toBe(30);
    });

    await test('test_ResultsQuery', async () => {
        const lattice = await Lattice.open(uniqueDbPath(), [Person, Dog]);

        await lattice.write(async () => {
            const p1 = new Person(); p1.name = 'John'; p1.age = 30; await lattice.add(p1);
            const p2 = new Person(); p2.name = 'Jane'; p2.age = 25; await lattice.add(p2);
            const p3 = new Person(); p3.name = 'Tim'; p3.age = 22; await lattice.add(p3);
        });

        // Results is now live - use count() or snapshot()
        const allPersons = lattice.objects(Person);
        expect(await allPersons.count()).toBe(3);

        // Test chained where clause
        const filtered = lattice.objects(Person).where("name = 'John' OR name = 'Jane'");
        expect(await filtered.count()).toBe(2);

        // Test async iteration
        const names: string[] = [];
        for await (const person of allPersons) {
            names.push(person.name);
        }
        expect(names.length).toBe(3);

        // Test snapshot
        const snapshot = await filtered.snapshot();
        expect(snapshot.length).toBe(2);
    });

    await test('test_Count', async () => {
        const lattice = await Lattice.open(uniqueDbPath(), [Person, Dog]);

        await lattice.write(async () => {
            for (let i = 0; i < 10; i++) {
                const p = new Person();
                p.name = `Person ${i}`;
                p.age = 20 + i;
                await lattice.add(p);
            }
        });

        const count = await lattice.count(Person);
        expect(count).toBe(10);

        const filtered = await lattice.count(Person, 'age >= 25');
        expect(filtered).toBe(5);
    });

    await test('test_Remove', async () => {
        const lattice = await Lattice.open(uniqueDbPath(), [Person, Dog]);

        const person = new Person();
        person.name = 'ToDelete';
        await lattice.add(person);

        expect(await lattice.count(Person)).toBe(1);

        const removed = await lattice.remove(Person, person.id!);
        expect(removed).toBe(true);

        expect(await lattice.count(Person)).toBe(0);
    });

    await test('test_RemoveQueriedObject', async () => {
        // This tests removing an object that was fetched via query,
        // which uses dataToInstance() and must properly set id/globalId
        const lattice = await Lattice.open(uniqueDbPath(), [Person, Dog]);

        // Add a person
        const person = new Person();
        person.name = 'QueryThenDelete';
        person.age = 30;
        await lattice.add(person);

        expect(await lattice.count(Person)).toBe(1);

        // Query to get the person back (uses dataToInstance)
        const people = await lattice.objectsArray(Person);
        expect(people.length).toBe(1);

        const queried = people[0];
        expect(queried.name).toBe('QueryThenDelete');
        expect(queried.id! > 0).toBe(true); // Should be a valid id, not garbage
        expect(queried.id! < 1000).toBe(true); // Sanity check - not garbage like 4745197494890136000

        // Remove using the queried object's id
        const removed = await lattice.remove(Person, queried.id!);
        expect(removed).toBe(true);

        expect(await lattice.count(Person)).toBe(0);
    });

    await test('test_BulkInsert', async () => {
        const lattice = await Lattice.open(uniqueDbPath(), [Person, Dog]);

        await lattice.write(async () => {
            for (let i = 0; i < 100; i++) {
                const p = new Person();
                p.name = `Person ${i}`;
                p.age = i;
                await lattice.add(p);
            }
        });

        const count = await lattice.count(Person);
        expect(count).toBe(100);
    });

    await test('test_LinkResolution', async () => {
        const lattice = await Lattice.open(uniqueDbPath(), [Person, Dog]);

        // Create a dog
        const dog = new Dog();
        dog.name = 'Buddy';
        await lattice.add(dog);
        expect(dog.id).toBeDefined();
        console.log('Dog created with id:', dog.id, 'globalId:', dog.globalId);

        // Create a person with the dog
        const person = new Person();
        person.name = 'John';
        person.age = 30;
        console.log('Before assign - dog.id:', dog.id);
        person.dog = dog; // Assign the dog object
        console.log('After assign - dog assigned');
        await lattice.add(person);
        expect(person.id).toBeDefined();
        console.log('Person created with id:', person.id);

        // Fetch the person and check the dog link - should be resolved automatically
        const foundPerson = await lattice.find(Person, person.id!);
        expect(foundPerson).toBeDefined();
        console.log('Found person, checking dog link...');

        // The dog property should be a Dog instance (resolved via C++ getObject)
        const linkedDog = foundPerson!.dog;
        console.log('linkedDog:', linkedDog);
        expect(linkedDog).toBeDefined();
        expect(linkedDog.name).toBe('Buddy');
    });

    await test('test_LinkAssignment', async () => {
        const lattice = await Lattice.open(uniqueDbPath(), [Person, Dog]);

        // Create and add a dog first
        const dog = new Dog();
        dog.name = 'Max';
        await lattice.add(dog);

        // Create person with dog link set BEFORE adding
        const person = new Person();
        person.name = 'Jane';
        person.age = 25;
        person.dog = dog;  // Set link before add
        await lattice.add(person);

        // Fetch fresh - dog should be resolved automatically
        const found = await lattice.find(Person, person.id!);
        console.log('Found person dog:', found!.dog);
        expect(found!.dog?.name).toBe('Max');
    });

    await test('test_ListAppendAndIterate', async () => {
        const lattice = await Lattice.open(uniqueDbPath(), [Person, Dog]);

        // Create parent dog
        const parent = new Dog();
        parent.name = 'Rex';
        await lattice.add(parent);
        expect(parent.id).toBeDefined();

        // Create puppies
        const puppy1 = new Dog();
        puppy1.name = 'Spot';
        await lattice.add(puppy1);

        const puppy2 = new Dog();
        puppy2.name = 'Buddy';
        await lattice.add(puppy2);

        // Add puppies to parent's list
        const puppies = parent.puppies;
        console.log('Initial puppies length:', puppies.length);
        expect(puppies.length).toBe(0);

        puppies.push(puppy1);
        puppies.push(puppy2);
        console.log('After push, puppies length:', puppies.length);
        expect(puppies.length).toBe(2);

        // Debug: List tables and check junction table
        console.log('Tables in DB:', lattice.debugListTables());
        console.log('Junction table contents:', lattice.debugQueryCount('SELECT * FROM "_Dog_Dog_puppies"'));

        // Iterate over puppies
        const names: string[] = [];
        for (const puppy of puppies) {
            names.push(puppy.name);
        }
        console.log('Puppy names:', names);
        expect(names.length).toBe(2);
        expect(names).toEqual(['Spot', 'Buddy']);

        // Fetch fresh and check list persists
        const foundParent = await lattice.find(Dog, parent.id!);
        expect(foundParent).toBeDefined();
        const foundPuppies = foundParent!.puppies;
        console.log('Found puppies length:', foundPuppies.length);
        expect(foundPuppies.length).toBe(2);
        expect(foundPuppies.at(0)?.name).toBe('Spot');
        expect(foundPuppies.at(1)?.name).toBe('Buddy');
    });

    await test('test_DateRoundTrip', async () => {
        const lattice = await Lattice.open(uniqueDbPath(), [Event]);

        // Create event with specific date
        const testDate = new Date('2024-06-15T10:30:00.000Z');
        const event = new Event();
        event.title = 'Birthday Party';
        event.createdAt = testDate;
        await lattice.add(event);

        expect(event.id).toBeDefined();
        console.log('Event created with id:', event.id);

        // Fetch and verify date is preserved
        const found = await lattice.find(Event, event.id!);
        expect(found).toBeDefined();
        expect(found!.title).toBe('Birthday Party');

        // Check date round-trip
        console.log('Original date:', testDate.toISOString());
        console.log('Found date:', found!.createdAt?.toISOString());

        expect(found!.createdAt instanceof Date).toBe(true);
        // Compare timestamps (within 1 second tolerance for float precision)
        const diff = Math.abs(found!.createdAt.getTime() - testDate.getTime());
        if (diff > 1000) {
            throw new Error(`Date mismatch: expected ${testDate.toISOString()} but got ${found!.createdAt?.toISOString()}`);
        }

        // Test null date
        expect(found!.updatedAt).toBeNull();

        // Update the nullable date
        const updateDate = new Date('2024-07-20T15:00:00.000Z');
        found!.updatedAt = updateDate;
        console.log('Set updatedAt to:', updateDate.toISOString());

        // Fetch again and verify
        const found2 = await lattice.find(Event, event.id!);
        console.log('Found2 updatedAt:', found2!.updatedAt?.toISOString());
        expect(found2!.updatedAt instanceof Date).toBe(true);
        const diff2 = Math.abs(found2!.updatedAt!.getTime() - updateDate.getTime());
        if (diff2 > 1000) {
            throw new Error(`Updated date mismatch: expected ${updateDate.toISOString()} but got ${found2!.updatedAt?.toISOString()}`);
        }
    });

    await test('test_Observation', async () => {
        const lattice = await Lattice.open(uniqueDbPath(), [Person, Dog]);

        // Track observed entries
        const observedEntries: any[] = [];

        // Start observing
        const unsubscribe = lattice.observe((entries) => {
            console.log('[Observation] Received entries:', entries.length);
            observedEntries.push(...entries);
        });

        // Add a person - should trigger observation
        const person = new Person();
        person.name = 'ObservedPerson';
        person.age = 42;
        await lattice.add(person);

        // Give a tick for the observer callback to fire
        await new Promise(resolve => setTimeout(resolve, 50));

        console.log('Observed entries count:', observedEntries.length);

        // Should have at least one entry for the INSERT
        expect(observedEntries.length).toBeGreaterThan(0);

        // Check the entry details
        const insertEntry = observedEntries.find(e => e.tableName === 'Person' && e.operation === 'INSERT');
        expect(insertEntry).toBeDefined();
        expect(insertEntry.tableName).toBe('Person');
        expect(insertEntry.operation).toBe('INSERT');

        // Stop observing
        unsubscribe();

        // Add another person - should NOT trigger observation
        const before = observedEntries.length;
        const person2 = new Person();
        person2.name = 'UnobservedPerson';
        person2.age = 33;
        await lattice.add(person2);
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(observedEntries.length).toBe(before);
        console.log('Observation test passed - unsubscribe works');
    });

    await test('test_PersistentDB_WorkerSync', async () => {
        // Test that persistent databases create worker + BroadcastChannel sync
        // Use a unique path so we don't conflict with other test runs
        const dbPath = `test-db-${Date.now()}`;

        console.log('Opening persistent database:', dbPath);
        const lattice = await Lattice.open(dbPath, [Person, Dog]);
        console.log('Persistent database opened');

        // Add a person - this should sync to the worker
        const person = new Person();
        person.name = 'PersistentPerson';
        person.age = 55;
        await lattice.add(person);
        console.log('Person added, id:', person.id);

        expect(person.id).toBeDefined();

        // Verify we can read back
        const found = await lattice.find(Person, person.id!);
        expect(found).toBeDefined();
        expect(found!.name).toBe('PersistentPerson');
        expect(found!.age).toBe(55);

        // Give time for sync to worker
        await new Promise(resolve => setTimeout(resolve, 100));

        console.log('Persistent database test passed - worker sync active');
    });

    await test('test_SyncLoop_Debug', async () => {
        // This test simulates the scenario where data comes from a server
        // and checks if it would cause an infinite loop

        console.log('=== SYNC LOOP DEBUG TEST ===');

        // Create two in-memory lattices to simulate main thread and "server data"
        const mainLattice = await Lattice.open(':memory:sync-test-main', [Person]);
        const serverLattice = await Lattice.open(':memory:sync-test-server', [Person]);

        // Track all observations on the main lattice
        const mainObservations: any[] = [];
        let observationCount = 0;

        const unsubMain = mainLattice.observe((entries) => {
            observationCount++;
            console.log(`[MainLattice] Observation #${observationCount}:`, entries.length, 'entries');
            entries.forEach(e => {
                console.log(`  - ${e.operation} ${e.tableName} globalId=${e.globalId?.substring(0,8)} isFromRemote=${e.isFromRemote}`);
                mainObservations.push(e);
            });

            // Safety: if we see too many observations, something is wrong
            if (observationCount > 10) {
                throw new Error('Too many observations - possible infinite loop!');
            }
        });

        console.log('\n--- Step 1: Create local change on main lattice ---');
        const localPerson = new Person();
        localPerson.name = 'LocalPerson';
        localPerson.age = 30;
        await mainLattice.add(localPerson);

        await new Promise(resolve => setTimeout(resolve, 100));
        console.log(`After local add: ${observationCount} observations, isFromRemote values:`,
            mainObservations.map(e => e.isFromRemote));

        // Get the audit log entry to simulate server echo
        const pendingJson = (mainLattice as any).db.getPendingAuditLog();
        const pending = JSON.parse(pendingJson);
        console.log('\n--- Step 2: Pending entries from main lattice ---');
        pending.forEach((e: any) => {
            console.log(`  - ${e.operation} ${e.tableName} globalId=${e.globalId?.substring(0,8)} isFromRemote=${e.isFromRemote}`);
        });

        console.log('\n--- Step 3: Simulate server echoing back the same data ---');
        const beforeCount = observationCount;

        // This simulates what happens when the server sends data back
        // The applyRemoteChanges should mark entries as isFromRemote=1
        mainLattice.applyRemoteChanges(pending);

        await new Promise(resolve => setTimeout(resolve, 100));
        console.log(`After applyRemoteChanges: ${observationCount} observations (was ${beforeCount})`);
        console.log('New observations:', mainObservations.slice(beforeCount).map(e => ({
            op: e.operation,
            isFromRemote: e.isFromRemote,
            globalId: e.globalId?.substring(0,8)
        })));

        console.log('\n--- Step 4: Check pending after remote apply ---');
        const pendingAfter = JSON.parse((mainLattice as any).db.getPendingAuditLog());
        console.log('Pending entries after apply:', pendingAfter.length);
        pendingAfter.forEach((e: any) => {
            console.log(`  - ${e.operation} ${e.tableName} globalId=${e.globalId?.substring(0,8)} isFromRemote=${e.isFromRemote}`);
        });

        unsubMain();
        console.log('\n=== SYNC LOOP DEBUG TEST COMPLETE ===');
        console.log(`Total observations: ${observationCount}`);

        // The test passes if we didn't hit the loop protection
        if (observationCount >= 10) {
            throw new Error(`Too many observations: ${observationCount}`);
        }
    });

    await test('test_SyncLoop_WithBroadcastChannel', async () => {
        // This test simulates the REAL architecture:
        // - Main thread lattice (in-memory) with observer
        // - SharedWorker lattice (simulated with another in-memory) with observer
        // - BroadcastChannel connecting them

        console.log('=== SYNC LOOP WITH BROADCAST CHANNEL TEST ===');

        // Simulate the two lattices
        const mainLattice = await Lattice.open(':memory:', [Person]);
        const workerLattice = await Lattice.open(':memory:', [Person]);

        // Simulate BroadcastChannel with direct function calls
        let broadcastCount = 0;
        const maxBroadcasts = 20;

        // Track what each side observes
        const mainObservations: any[] = [];
        const workerObservations: any[] = [];

        // Simulate main thread broadcasting to worker
        function mainBroadcastToWorker(entries: any[]) {
            broadcastCount++;
            console.log(`[Broadcast #${broadcastCount}] Main -> Worker:`, entries.length, 'entries');
            if (broadcastCount > maxBroadcasts) {
                throw new Error(`Too many broadcasts: ${broadcastCount} - INFINITE LOOP DETECTED`);
            }
            // Worker receives and applies as remote
            const json = JSON.stringify(entries);
            workerLattice.applyRemoteChanges(JSON.parse(json));
        }

        // Simulate worker broadcasting to main
        function workerBroadcastToMain(entries: any[]) {
            broadcastCount++;
            console.log(`[Broadcast #${broadcastCount}] Worker -> Main:`, entries.length, 'entries');
            if (broadcastCount > maxBroadcasts) {
                throw new Error(`Too many broadcasts: ${broadcastCount} - INFINITE LOOP DETECTED`);
            }
            // Main receives and applies as remote
            const json = JSON.stringify(entries);
            mainLattice.applyRemoteChanges(JSON.parse(json));
        }

        // Set up main thread observer (like in openPersistent)
        const unsubMain = mainLattice.observe((entries) => {
            console.log('[Main Observer]', entries.length, 'entries:', entries.map(e => ({
                op: e.operation,
                isFromRemote: e.isFromRemote,
                globalId: e.globalId?.substring(0, 8)
            })));
            mainObservations.push(...entries);

            // Only broadcast LOCAL changes (not remote ones)
            const localEntries = entries.filter(e => !e.isFromRemote);
            if (localEntries.length > 0) {
                console.log('[Main] Broadcasting', localEntries.length, 'local entries to worker');
                mainBroadcastToWorker(localEntries);
            }
        });

        // Set up worker observer (like in shared-impl.ts)
        const unsubWorker = workerLattice.observe((entries) => {
            console.log('[Worker Observer]', entries.length, 'entries:', entries.map(e => ({
                op: e.operation,
                isFromRemote: e.isFromRemote,
                globalId: e.globalId?.substring(0, 8)
            })));
            workerObservations.push(...entries);

            // Only broadcast LOCAL changes (not remote ones)
            const localEntries = entries.filter(e => !e.isFromRemote);
            if (localEntries.length > 0) {
                console.log('[Worker] Broadcasting', localEntries.length, 'local entries to main');
                workerBroadcastToMain(localEntries);
            }
        });

        console.log('\n--- Step 1: Add person on main thread ---');
        const person = new Person();
        person.name = 'TestPerson';
        person.age = 25;
        await mainLattice.add(person);

        // Wait for async callbacks
        await new Promise(resolve => setTimeout(resolve, 200));

        console.log('\n--- Results ---');
        console.log('Total broadcasts:', broadcastCount);
        console.log('Main observations:', mainObservations.length);
        console.log('Worker observations:', workerObservations.length);

        unsubMain();
        unsubWorker();

        console.log('=== TEST COMPLETE ===');

        // Should have minimal broadcasts: main->worker once, no echo back
        if (broadcastCount > 5) {
            throw new Error(`Too many broadcasts: ${broadcastCount}`);
        }
    });

    // ========================================================================
    // New feature tests
    // ========================================================================

    await test('test_GroupBy', async () => {
        const lattice = await Lattice.open(uniqueDbPath(), [Person, Dog]);

        await lattice.write(async () => {
            for (const [name, age] of [['Alice', 25], ['Bob', 25], ['Carol', 30], ['Dave', 30], ['Eve', 35]] as const) {
                const p = new Person();
                p.name = name;
                p.age = age as number;
                await lattice.add(p);
            }
        });

        // GROUP BY age should give us 3 groups
        const grouped = lattice.objects(Person).groupBy('age');
        const snapshot = await grouped.snapshot();
        expect(snapshot.length).toBe(3);

        // DISTINCT by age
        const distinct = lattice.objects(Person).distinct('age');
        const distinctSnap = await distinct.snapshot();
        expect(distinctSnap.length).toBe(3);
    });

    await test('test_TypeSafeQueryBuilder', async () => {
        const lattice = await Lattice.open(uniqueDbPath(), [Person, Dog]);

        await lattice.write(async () => {
            const p1 = new Person(); p1.name = 'John'; p1.age = 30; await lattice.add(p1);
            const p2 = new Person(); p2.name = 'Jane'; p2.age = 25; await lattice.add(p2);
            const p3 = new Person(); p3.name = 'Jim'; p3.age = 40; await lattice.add(p3);
        });

        // Type-safe where with query builder
        const adults = lattice.objects(Person).where(q => q.age.gte(30));
        expect(await adults.count()).toBe(2);

        // Chained conditions
        const jAdults = lattice.objects(Person).where(q =>
            q.age.gte(30).and(q.name.startsWith('J'))
        );
        const snap = await jAdults.snapshot();
        expect(snap.length).toBe(2);
        expect(snap.map((p: any) => p.name).sort()).toEqual(['Jim', 'John']);
    });

    await test('test_AddAll_BulkInsert', async () => {
        const lattice = await Lattice.open(uniqueDbPath(), [Person, Dog]);

        const people: Person[] = [];
        for (let i = 0; i < 50; i++) {
            const p = new Person();
            p.name = `Person ${i}`;
            p.age = 20 + i;
            people.push(p);
        }

        await lattice.addAll(people);

        const count = await lattice.count(Person);
        expect(count).toBe(50);
    });

    await test('test_FineGrainedTableObservation', async () => {
        const lattice = await Lattice.open(uniqueDbPath(), [Person, Dog]);

        const changes: any[] = [];
        const unsubscribe = lattice.observeTable(Person, (change) => {
            changes.push(change);
        });

        const person = new Person();
        person.name = 'Observed';
        person.age = 42;
        await lattice.add(person);

        await new Promise(resolve => setTimeout(resolve, 50));
        expect(changes.length).toBeGreaterThan(0);

        const insertChange = changes.find((c: any) => c.operation === 'INSERT');
        expect(insertChange).toBeDefined();

        unsubscribe();
    });

    await test('test_EmbeddedModel', async () => {
        class Address {
            street = '';
            city = '';
            zip = '';
        }

        @model
        class PersonWithAddress {
            name = '';
            address = embedded(Address);
        }

        const lattice = await Lattice.open(uniqueDbPath(), [PersonWithAddress]);

        const person = new PersonWithAddress();
        person.name = 'John';
        const addr = new Address();
        addr.street = '123 Main St';
        addr.city = 'Springfield';
        addr.zip = '62701';
        person.address = addr;

        await lattice.add(person);
        expect(person.id).toBeDefined();

        const found = await lattice.find(PersonWithAddress, person.id!);
        expect(found).toBeDefined();
        expect(found!.name).toBe('John');
        expect(found!.address?.street).toBe('123 Main St');
        expect(found!.address?.city).toBe('Springfield');
        expect(found!.address?.zip).toBe('62701');
    });

    await test('test_EnumValue', async () => {
        enum Status { Active = 'active', Inactive = 'inactive' }

        @model
        class Task {
            title = '';
            status = enumValue(Status, Status.Active);
        }

        const lattice = await Lattice.open(uniqueDbPath(), [Task]);

        const task = new Task();
        task.title = 'Do stuff';
        task.status = Status.Inactive;
        await lattice.add(task);

        const found = await lattice.find(Task, task.id!);
        expect(found).toBeDefined();
        expect(found!.status).toBe('inactive');
    });

    await test('test_RealServerSync', async () => {
        // This test connects to a REAL sync server to test the actual sync behavior
        // Assumes a sync server is running at ws://localhost:5050/sync

        const SERVER_URL = 'ws://localhost:5050/sync';
        const AUTH_TOKEN = 'test-token-1'; // Use test token for authentication

        console.log('=== REAL SERVER SYNC TEST ===');
        console.log('Connecting to:', SERVER_URL);

        // Track observations
        const observations: any[] = [];
        let observationCount = 0;
        const maxObservations = 20;

        // Open lattice with sync enabled (persistent DB like the real app)
        const dbPath = `sync-test-${Date.now()}`;
        const lattice = await Lattice.open(dbPath, [Person], {
            sync: {
                websocketUrl: SERVER_URL,
                authToken: AUTH_TOKEN
            }
        });

        console.log('Lattice opened with sync');

        // Set up observer
        const unsubscribe = lattice.observe((entries) => {
            observationCount++;
            console.log(`[Observation #${observationCount}]`, entries.length, 'entries:');
            entries.forEach(e => {
                console.log(`  - ${e.operation} ${e.tableName} globalId=${e.globalId?.substring(0,8)} isFromRemote=${e.isFromRemote}`);
            });
            observations.push(...entries);

            if (observationCount > maxObservations) {
                throw new Error(`Too many observations: ${observationCount} - INFINITE LOOP DETECTED`);
            }
        });

        // Give time for WebSocket connection
        await new Promise(resolve => setTimeout(resolve, 500));
        console.log('\n--- Adding person ---');

        const person = new Person();
        person.name = 'ServerTestPerson';
        person.age = 99;
        await lattice.add(person);

        console.log('Person added, id:', person.id);

        // Wait for server to echo back (and potentially cause a loop)
        console.log('\n--- Waiting for server response ---');
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log('\n--- Results ---');
        console.log('Total observations:', observationCount);
        console.log('Observations breakdown:');
        const localObs = observations.filter(e => !e.isFromRemote);
        const remoteObs = observations.filter(e => e.isFromRemote);
        console.log('  Local:', localObs.length);
        console.log('  Remote:', remoteObs.length);

        unsubscribe();
        await lattice.close();

        console.log('=== REAL SERVER SYNC TEST COMPLETE ===');

        // Success if we didn't hit the loop protection
        if (observationCount > maxObservations) {
            throw new Error(`Infinite loop detected: ${observationCount} observations`);
        }

        // We expect 1 local observation (our INSERT)
        // We should NOT get a remote observation that triggers another local broadcast
        expect(localObs.length).toBe(1);
    });
}

// Run on load
runTests().catch(console.error);
