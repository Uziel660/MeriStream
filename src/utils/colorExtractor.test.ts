import { describe, it, expect } from 'vitest';
import { rgbToRgbaString } from './colorExtractor';

describe('rgbToRgbaString', () => {
  it('formats correctly with solid alpha', () => {
    expect(rgbToRgbaString([255, 0, 0], 1)).toBe('rgba(255, 0, 0, 1)');
  });

  it('formats correctly with decimal alpha', () => {
    expect(rgbToRgbaString([0, 255, 0], 0.5)).toBe('rgba(0, 255, 0, 0.5)');
  });

  it('formats correctly with 0 alpha', () => {
    expect(rgbToRgbaString([0, 0, 255], 0)).toBe('rgba(0, 0, 255, 0)');
  });

  it('handles zero rgb values', () => {
    expect(rgbToRgbaString([0, 0, 0], 0.8)).toBe('rgba(0, 0, 0, 0.8)');
  });
});
