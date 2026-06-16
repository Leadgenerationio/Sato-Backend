import { describe, it, expect } from 'vitest';
import { largestRemainderAllocate } from '../utils/allocate.js';

describe('largestRemainderAllocate', () => {
  it('splits evenly when shares are equal and divisible', () => {
    expect(largestRemainderAllocate(10, [0.5, 0.5])).toEqual([5, 5]);
  });

  it('respects weighted shares', () => {
    expect(largestRemainderAllocate(10, [0.7, 0.3])).toEqual([7, 3]);
  });

  it('gives the leftover unit to the largest remainder', () => {
    // raw = [2.5, 2.5] → floors [2,2], 1 left → first (tie) gets it.
    expect(largestRemainderAllocate(5, [0.5, 0.5])).toEqual([3, 2]);
  });

  it('always preserves the total (no leads gained or lost)', () => {
    const cases: Array<[number, number[]]> = [
      [10, [1 / 3, 1 / 3, 1 / 3]],
      [7, [0.2, 0.2, 0.6]],
      [101, [0.45, 0.55]],
      [3, [0.1, 0.1, 0.1, 0.7]],
      [86, [0.33, 0.33, 0.34]],
    ];
    for (const [total, shares] of cases) {
      const alloc = largestRemainderAllocate(total, shares);
      expect(alloc.reduce((s, x) => s + x, 0)).toBe(total);
      expect(alloc.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    }
  });

  it('handles a single bucket and zero total', () => {
    expect(largestRemainderAllocate(7, [1])).toEqual([7]);
    expect(largestRemainderAllocate(0, [0.5, 0.5])).toEqual([0, 0]);
    expect(largestRemainderAllocate(10, [])).toEqual([]);
  });
});
