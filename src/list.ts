// List<T> - Collection type for to-many relationships
import type { ModelConstructor, LatticeObject } from './types';
import { DYNAMIC_OBJECT, LATTICE_REF } from './storage';
import { hydrateInstance } from './decorators';
import { getTableName } from './decorators';

/**
 * List<T> represents a to-many relationship in Lattice.
 * It wraps a C++ LinkList and provides array-like access to related objects.
 */
export class List<T extends LatticeObject> implements Iterable<T> {
    private linkList: any; // C++ LinkList from WASM
    private targetModel: ModelConstructor<T>;
    private lattice: any; // Lattice instance for creating model instances

    constructor(linkList: any, targetModel: ModelConstructor<T>, lattice: any) {
        this.linkList = linkList;
        this.targetModel = targetModel;
        this.lattice = lattice;
    }

    /**
     * Number of items in the list.
     */
    get length(): number {
        return this.linkList?.size() ?? 0;
    }

    /**
     * Check if the list is empty.
     */
    get isEmpty(): boolean {
        return this.linkList?.empty() ?? true;
    }

    /**
     * Get item at index.
     */
    at(index: number): T | undefined {
        if (!this.linkList || index < 0 || index >= this.length) {
            return undefined;
        }

        const dynObj = this.linkList.at(index);
        if (!dynObj || !dynObj.isValid()) {
            return undefined;
        }

        return this.wrapDynamicObject(dynObj);
    }

    /**
     * Get first item.
     */
    get first(): T | undefined {
        return this.at(0);
    }

    /**
     * Get last item.
     */
    get last(): T | undefined {
        return this.length > 0 ? this.at(this.length - 1) : undefined;
    }

    /**
     * Append an item to the list.
     * The item must already be added to the database.
     */
    push(item: T): void {
        if (!this.linkList) return;

        const dynObj = (item as any)[DYNAMIC_OBJECT];
        if (!dynObj) {
            throw new Error('Cannot add item to list - item must be added to database first');
        }

        this.linkList.push_back(dynObj);
    }

    /**
     * Append an item (alias for push).
     */
    append(item: T): void {
        this.push(item);
    }

    /**
     * Remove item at index.
     */
    removeAt(index: number): T | undefined {
        if (!this.linkList || index < 0 || index >= this.length) {
            return undefined;
        }

        const item = this.at(index);
        this.linkList.erase(index);
        return item;
    }

    /**
     * Remove all items from the list.
     */
    clear(): void {
        this.linkList?.clear();
    }

    /**
     * Iterate over items.
     */
    *[Symbol.iterator](): Iterator<T> {
        for (let i = 0; i < this.length; i++) {
            const item = this.at(i);
            if (item) yield item;
        }
    }

    /**
     * Convert to array.
     */
    toArray(): T[] {
        return Array.from(this);
    }

    /**
     * Map over items.
     */
    map<U>(fn: (item: T, index: number) => U): U[] {
        const result: U[] = [];
        let i = 0;
        for (const item of this) {
            result.push(fn(item, i++));
        }
        return result;
    }

    /**
     * Filter items.
     */
    filter(fn: (item: T, index: number) => boolean): T[] {
        const result: T[] = [];
        let i = 0;
        for (const item of this) {
            if (fn(item, i++)) {
                result.push(item);
            }
        }
        return result;
    }

    /**
     * Find first item matching predicate.
     */
    find(fn: (item: T, index: number) => boolean): T | undefined {
        let i = 0;
        for (const item of this) {
            if (fn(item, i++)) {
                return item;
            }
        }
        return undefined;
    }

    /**
     * Check if any item matches predicate.
     */
    some(fn: (item: T, index: number) => boolean): boolean {
        return this.find(fn) !== undefined;
    }

    /**
     * Check if all items match predicate.
     */
    every(fn: (item: T, index: number) => boolean): boolean {
        let i = 0;
        for (const item of this) {
            if (!fn(item, i++)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Create a model instance from a C++ DynamicObject.
     */
    private wrapDynamicObject(dynObj: any): T {
        return hydrateInstance(this.targetModel, dynObj, this.lattice);
    }
}
