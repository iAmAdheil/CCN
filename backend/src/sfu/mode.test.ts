import { describe, expect, it } from 'vitest';
import { modeForSize, MESH_MAX } from './mode.js';

describe('sfu/mode', () => {
  it('returns mesh at and below the threshold', () => {
    expect(modeForSize(0)).toBe('mesh');
    expect(modeForSize(1)).toBe('mesh');
    expect(modeForSize(MESH_MAX)).toBe('mesh');
  });
  it('returns sfu above the threshold', () => {
    expect(modeForSize(MESH_MAX + 1)).toBe('sfu');
    expect(modeForSize(100)).toBe('sfu');
  });
});
