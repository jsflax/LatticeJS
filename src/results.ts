// Live query results - always fetches fresh from database
import type { ModelConstructor, LatticeWasm } from './types';
import { getTableName, getPropertySchemas } from './decorators';
import { DYNAMIC_OBJECT } from './storage';

/**
 * Options for querying results.
 */
export interface QueryOptions {
    where?: string;
    orderBy?: string;
    limit?: number;
    offset?: number;
}

/**
 * Live query results. Always fetches fresh data from the database.
 *
 * @example
 * ```typescript
 * const results = lattice.objects(Person);
 *
 * // Iterate (fetches in batches)
 * for await (const person of results) {
 *     console.log(person.name);
 * }
 *
 * // Chain filters
 * const adults = results.where("age >= 18").sorted("name ASC");
 *
 * // Get count (live)
 * console.log(await results.count());
 *
 * // Get snapshot (frozen array)
 * const snapshot = await results.snapshot();
 * ```
 */
export class Results<T> implements AsyncIterable<T> {
    private db: LatticeWasm;
    private modelClass: ModelConstructor<T>;
    private tableName: string;
    private whereClause: string | null;
    private orderByClause: string | null;
    private instanceFactory: (data: Record<string, unknown>) => T;

    constructor(
        db: LatticeWasm,
        modelClass: ModelConstructor<T>,
        instanceFactory: (data: Record<string, unknown>) => T,
        options?: QueryOptions
    ) {
        this.db = db;
        this.modelClass = modelClass;
        this.tableName = getTableName(modelClass);
        this.whereClause = options?.where ?? null;
        this.orderByClause = options?.orderBy ?? null;
        this.instanceFactory = instanceFactory;
    }

    /**
     * Get the count of matching objects (live query).
     */
    async count(): Promise<number> {
        const count = this.db.count(this.tableName, this.whereClause);
        return typeof count === 'bigint' ? Number(count) : count;
    }

    /**
     * Get the number of matching objects (alias for count).
     */
    get length(): Promise<number> {
        return this.count();
    }

    /**
     * Get object at index (live query).
     */
    async at(index: number): Promise<T | undefined> {
        const data = this.db.objects(
            this.tableName,
            this.whereClause,
            this.orderByClause,
            1,      // limit
            index   // offset
        );
        if (data.length === 0) return undefined;
        return this.instanceFactory(data[0]);
    }

    /**
     * Get first object matching the query.
     */
    async first(): Promise<T | undefined> {
        return this.at(0);
    }

    /**
     * Get all objects as an array (snapshot - not live).
     */
    async snapshot(): Promise<T[]> {
        const data = this.db.objects(
            this.tableName,
            this.whereClause,
            this.orderByClause,
            null,
            null
        );
        return data.map((d: Record<string, any>) => this.instanceFactory(d));
    }

    /**
     * Filter results with a WHERE clause.
     * Returns a new Results instance (chainable).
     */
    where(clause: string): Results<T> {
        const combined = this.whereClause
            ? `(${this.whereClause}) AND (${clause})`
            : clause;
        return new Results(this.db, this.modelClass, this.instanceFactory, {
            where: combined,
            orderBy: this.orderByClause ?? undefined,
        });
    }

    /**
     * Sort results.
     * Returns a new Results instance (chainable).
     *
     * @param clause - e.g., "name ASC", "age DESC", "name ASC, age DESC"
     */
    sorted(clause: string): Results<T> {
        return new Results(this.db, this.modelClass, this.instanceFactory, {
            where: this.whereClause ?? undefined,
            orderBy: clause,
        });
    }

    /**
     * Limit results.
     * Returns a new Results instance (chainable).
     */
    limit(n: number): Results<T> {
        // For limit, we need to return a LimitedResults or handle differently
        // For now, create a simple wrapper that fetches with limit
        return new LimitedResults(this.db, this.modelClass, this.instanceFactory, {
            where: this.whereClause ?? undefined,
            orderBy: this.orderByClause ?? undefined,
            limit: n,
        });
    }

    /**
     * Async iterator - fetches in batches for efficiency.
     */
    async *[Symbol.asyncIterator](): AsyncGenerator<T, void, unknown> {
        const batchSize = 100;
        let offset = 0;

        while (true) {
            const batch = this.db.objects(
                this.tableName,
                this.whereClause,
                this.orderByClause,
                batchSize,
                offset
            );

            if (batch.length === 0) break;

            for (const data of batch) {
                yield this.instanceFactory(data);
            }

            if (batch.length < batchSize) break;
            offset += batchSize;
        }
    }

    /**
     * Map over results.
     */
    async map<U>(fn: (item: T) => U): Promise<U[]> {
        const results: U[] = [];
        for await (const item of this) {
            results.push(fn(item));
        }
        return results;
    }

    /**
     * Filter results (in memory - use .where() for DB-level filtering).
     */
    async filter(fn: (item: T) => boolean): Promise<T[]> {
        const results: T[] = [];
        for await (const item of this) {
            if (fn(item)) results.push(item);
        }
        return results;
    }

    /**
     * Find first matching item (in memory - use .where() for DB-level filtering).
     */
    async find(fn: (item: T) => boolean): Promise<T | undefined> {
        for await (const item of this) {
            if (fn(item)) return item;
        }
        return undefined;
    }

    /**
     * Convert to array (alias for snapshot).
     */
    async toArray(): Promise<T[]> {
        return this.snapshot();
    }
}

/**
 * Results with a limit applied.
 */
class LimitedResults<T> extends Results<T> {
    private _limit: number;

    constructor(
        db: LatticeWasm,
        modelClass: ModelConstructor<T>,
        instanceFactory: (data: Record<string, unknown>) => T,
        options: QueryOptions & { limit: number }
    ) {
        super(db, modelClass, instanceFactory, options);
        this._limit = options.limit;
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<T, void, unknown> {
        let count = 0;
        const parentIterator = super[Symbol.asyncIterator]();
        while (count < this._limit) {
            const { value, done } = await parentIterator.next();
            if (done) break;
            yield value;
            count++;
        }
    }

    async count(): Promise<number> {
        const total = await super.count();
        return Math.min(total, this._limit);
    }

    async snapshot(): Promise<T[]> {
        const all = await super.snapshot();
        return all.slice(0, this._limit);
    }
}
