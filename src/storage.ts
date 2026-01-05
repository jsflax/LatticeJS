// C++ backing storage for LatticeJS models
// This module provides access to the WASM dynamic_object_ref

import type { PropertyDescriptor } from './types';

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

/**
 * Property schema stored on model class.
 */
export interface PropertySchema {
    name: string;
    type: 'string' | 'int' | 'float' | 'bool' | 'blob' | 'date';
    kind: 'primitive' | 'link' | 'list';
    defaultValue: any;
    targetModel?: any; // For link/list
    nullable?: boolean;
}
