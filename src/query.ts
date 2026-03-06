// Type-safe query builder for LatticeJS
// Generates SQL WHERE clauses from a fluent API

/**
 * A query node represents a condition in a WHERE clause.
 */
export class QueryNode {
    constructor(private sql: string) {}

    toSQL(): string {
        return this.sql;
    }

    and(other: QueryNode): QueryNode {
        return new QueryNode(`(${this.sql}) AND (${other.sql})`);
    }

    or(other: QueryNode): QueryNode {
        return new QueryNode(`(${this.sql}) OR (${other.sql})`);
    }

    not(): QueryNode {
        return new QueryNode(`NOT (${this.sql})`);
    }
}

/**
 * A field builder provides comparison methods for a specific column.
 */
class FieldBuilder {
    constructor(private fieldName: string) {}

    private escape(value: unknown): string {
        if (value === null || value === undefined) return 'NULL';
        if (typeof value === 'number') return String(value);
        if (typeof value === 'boolean') return value ? '1' : '0';
        if (value instanceof Date) return String(value.getTime() / 1000);
        // Escape single quotes for strings
        return `'${String(value).replace(/'/g, "''")}'`;
    }

    eq(value: unknown): QueryNode {
        if (value === null || value === undefined) {
            return new QueryNode(`${this.fieldName} IS NULL`);
        }
        return new QueryNode(`${this.fieldName} = ${this.escape(value)}`);
    }

    neq(value: unknown): QueryNode {
        if (value === null || value === undefined) {
            return new QueryNode(`${this.fieldName} IS NOT NULL`);
        }
        return new QueryNode(`${this.fieldName} != ${this.escape(value)}`);
    }

    gt(value: number | Date): QueryNode {
        return new QueryNode(`${this.fieldName} > ${this.escape(value)}`);
    }

    gte(value: number | Date): QueryNode {
        return new QueryNode(`${this.fieldName} >= ${this.escape(value)}`);
    }

    lt(value: number | Date): QueryNode {
        return new QueryNode(`${this.fieldName} < ${this.escape(value)}`);
    }

    lte(value: number | Date): QueryNode {
        return new QueryNode(`${this.fieldName} <= ${this.escape(value)}`);
    }

    contains(value: string): QueryNode {
        const escaped = String(value).replace(/'/g, "''");
        return new QueryNode(`${this.fieldName} LIKE '%${escaped}%'`);
    }

    startsWith(value: string): QueryNode {
        const escaped = String(value).replace(/'/g, "''");
        return new QueryNode(`${this.fieldName} LIKE '${escaped}%'`);
    }

    endsWith(value: string): QueryNode {
        const escaped = String(value).replace(/'/g, "''");
        return new QueryNode(`${this.fieldName} LIKE '%${escaped}'`);
    }

    like(pattern: string): QueryNode {
        const escaped = pattern.replace(/'/g, "''");
        return new QueryNode(`${this.fieldName} LIKE '${escaped}'`);
    }

    in(values: unknown[]): QueryNode {
        const escaped = values.map(v => this.escape(v)).join(', ');
        return new QueryNode(`${this.fieldName} IN (${escaped})`);
    }

    between(a: number | Date, b: number | Date): QueryNode {
        return new QueryNode(`${this.fieldName} BETWEEN ${this.escape(a)} AND ${this.escape(b)}`);
    }

    isNull(): QueryNode {
        return new QueryNode(`${this.fieldName} IS NULL`);
    }

    isNotNull(): QueryNode {
        return new QueryNode(`${this.fieldName} IS NOT NULL`);
    }
}

/**
 * Type that maps model properties to FieldBuilders for type-safe queries.
 */
export type QueryProxy<T> = {
    [K in keyof T]: FieldBuilder;
};

/**
 * Creates a query proxy for a model type.
 * Used with Results.where() for type-safe queries.
 *
 * @example
 * ```typescript
 * const results = lattice.objects(Person)
 *     .where(q => q.age.gte(18).and(q.name.startsWith('J')));
 * ```
 */
export function createQueryProxy<T>(): QueryProxy<T> {
    return new Proxy({} as QueryProxy<T>, {
        get(_target, prop: string) {
            return new FieldBuilder(prop);
        },
    });
}
