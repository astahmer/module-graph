import type { MissingType } from 'missing-types-only-package';
import { runtimeValue } from './runtime.ts';

export type Local = MissingType;
export const value = runtimeValue;
