// C++ backing storage for LatticeJS models
// This module provides access to the WASM dynamic_object_ref

import type { PropertyDescriptor, UnionCaseDescriptor } from './types';

// Global WASM module reference (set when Lattice.open() is called)
let wasmModule: any = null;

/**
 * Set the WASM module reference. Called by Lattice.open().
 */
export function setWasmModule(module: any): void {
    wasmModule = module;
}

/**
 * Get the WASM module reference.
 */
export function getWasmModule(): any {
    return wasmModule;
}

/**
 * Check if WASM is available.
 */
export function isWasmReady(): boolean {
    return wasmModule !== null;
}

/**
 * Symbol for accessing the dynamic object on model instances.
 */
export const DYNAMIC_OBJECT = Symbol('lattice:dynamicObject');

/**
 * Symbol for accessing the lattice instance on model instances.
 */
export const LATTICE_REF = Symbol('lattice:latticeRef');

/**
 * Symbol for storing property schema on model classes.
 */
export const PROPERTY_SCHEMA = Symbol('lattice:propertySchema');
export const EXPLICIT_MODEL = Symbol('lattice:explicitModel');

/**
 * Property schema stored on model class.
 */
export interface PropertySchema {
    name: string;
    type: 'string' | 'int' | 'float' | 'bool' | 'blob' | 'date';
    kind: 'primitive' | 'link' | 'list' | 'union';
    defaultValue: any;
    targetModel?: any; // For link/list
    nullable?: boolean;
    isVector?: boolean;
    vectorDimensions?: number;
    isFullText?: boolean;
    isIndexed?: boolean;
    noHistory?: boolean;
    embeddedClass?: new () => any;
    enumObj?: Record<string, string | number>;
    targetTable?: string;
    logicalNullable?: boolean;
    unionCases?: readonly UnionCaseDescriptor[];
    /** Explicit descriptors use strict codecs, never inferred defaults. */
    explicit?: 'scalar' | 'bigint' | 'unixSeconds' | 'link' | 'union';
}
