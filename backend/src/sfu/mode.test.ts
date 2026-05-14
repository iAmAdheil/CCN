import { describe, expect, it } from 'vitest';
import { modeForSize, MESH_MAX } from './mode.js';

describe('sfu/mode', () => {
  it('returns mesh strictly below the threshold', () => {
    expect(modeForSize(0)).toBe('mesh');
    expect(modeForSize(1)).toBe('mesh');
    expect(modeForSize(MESH_MAX - 1)).toBe('mesh');
  });
  it('returns sfu at and above the threshold', () => {
    expect(modeForSize(MESH_MAX)).toBe('sfu');
    expect(modeForSize(MESH_MAX + 1)).toBe('sfu');
    expect(modeForSize(100)).toBe('sfu');
  });
});
