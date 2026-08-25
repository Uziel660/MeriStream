import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractDominantColor, rgbToRgbaString } from './colorExtractor';

describe('extractDominantColor', () => {
  let mockGetImageData: any;
  let mockDrawImage: any;
  let mockGetContext: any;
  let mockCreateElement: any;
  let currentImageInstance: any;

  beforeEach(() => {
    mockGetImageData = vi.fn().mockReturnValue({
      data: new Uint8ClampedArray(30 * 30 * 4) // Return empty transparent image by default
    });
    mockDrawImage = vi.fn();
    mockGetContext = vi.fn(() => ({
      drawImage: mockDrawImage,
      getImageData: mockGetImageData,
    }));

    mockCreateElement = vi.fn((tag: string) => {
      if (tag === 'canvas') {
        return {
          getContext: mockGetContext,
          width: 0,
          height: 0,
        };
      }
      return {};
    });

    global.document = {
      createElement: mockCreateElement
    } as any;

    global.Image = class {
      crossOrigin = '';
      src = '';
      onload: any = null;
      onerror: any = null;
      constructor() {
        currentImageInstance = this;
      }
    } as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (global as any).document;
    delete (global as any).Image;
  });

  it('returns fallback color when imageUrl is falsy', async () => {
    const color1 = await extractDominantColor(null, 'test');
    expect(color1).toBeDefined();
    expect(color1.length).toBe(3);
  });

  it('returns fallback color on image load error', async () => {
    const promise = extractDominantColor('error-url.jpg', 'fallback');
    expect(currentImageInstance).toBeDefined();
    expect(currentImageInstance.src).toBe('error-url.jpg');
    currentImageInstance.onerror();
    // Flush: la primera falla dispara el reintento vía proxy (nueva instancia Image)
    await new Promise((r) => setTimeout(r, 0));
    expect(currentImageInstance.src).toContain('/api/v1/proxy/stream?url=');
    currentImageInstance.onerror();
    const color = await promise;
    expect(color).toBeDefined();
    expect(color.length).toBe(3);
  });

  it('retries via backend proxy and extracts color when direct load fails', async () => {
    const data = new Uint8ClampedArray(30 * 30 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 0;     // R
      data[i + 1] = 0; // G
      data[i + 2] = 255; // B
      data[i + 3] = 255; // A
    }
    mockGetImageData.mockReturnValue({ data });

    const promise = extractDominantColor('https://s4.anilist.co/cover.jpg');
    currentImageInstance.onerror();
    await new Promise((r) => setTimeout(r, 0));
    expect(currentImageInstance.src).toContain('/api/v1/proxy/stream?url=');
    currentImageInstance.onload();

    const color = await promise;
    expect(color).toEqual([0, 0, 255]);
  });

  it('returns fallback color on context being null', async () => {
    mockGetContext.mockReturnValue(null);
    const promise = extractDominantColor('null-context.jpg', 'fallback');
    currentImageInstance.onload();
    const color = await promise;
    expect(color).toBeDefined();
  });

  it('returns fallback color on timeout of both direct and proxy attempts', async () => {
    vi.useFakeTimers();
    const promise = extractDominantColor('timeout-url.jpg', 'fallback');

    // Timeout del intento directo + timeout del reintento vía proxy
    vi.advanceTimersByTime(1300);
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(1300);

    const color = await promise;
    expect(color).toBeDefined();
    vi.useRealTimers();
  });

  it('returns dominant color from image data', async () => {
    // Fill image data with a vibrant color (e.g., Red)
    const data = new Uint8ClampedArray(30 * 30 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255;     // R
      data[i + 1] = 0;   // G
      data[i + 2] = 0;   // B
      data[i + 3] = 255; // A
    }
    mockGetImageData.mockReturnValue({ data });

    const promise = extractDominantColor('valid-url.jpg');
    currentImageInstance.onload();

    const color = await promise;
    expect(color).toEqual([255, 0, 0]);
  });

  it('uses cached color for same URL', async () => {
    const data = new Uint8ClampedArray(30 * 30 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 0;     // R
      data[i + 1] = 255;   // G
      data[i + 2] = 0;   // B
      data[i + 3] = 255; // A
    }
    mockGetImageData.mockReturnValue({ data });

    const promise1 = extractDominantColor('cached-url.jpg');
    currentImageInstance.onload();
    const color1 = await promise1;

    // Should return cached immediately
    const color2 = await extractDominantColor('cached-url.jpg');
    expect(color2).toEqual(color1);

    // Canvas should not be created again for the second call
    expect(mockCreateElement).toHaveBeenCalledTimes(1);
  });

  it('handles image data processing errors gracefully', async () => {
    mockGetImageData.mockImplementation(() => {
      throw new Error('Canvas error');
    });

    const promise = extractDominantColor('error-canvas.jpg', 'fallback');
    currentImageInstance.onload();

    const color = await promise;
    expect(color).toBeDefined(); // Should return fallback
  });
});

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
