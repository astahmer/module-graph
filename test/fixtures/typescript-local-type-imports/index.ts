import type { LocalType } from './types.ts';
import { runtimeValue } from './runtime.ts';

export type Local = LocalType;
export const value = runtimeValue;