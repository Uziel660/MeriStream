import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getDeliveryCapability,
  setDeliveryCapability,
  cleanOldCapabilities,
} from './deliveryCapabilities';

const mockLocalStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    }
  };
})();

vi.stubGlobal('localStorage', mockLocalStorage);

describe('deliveryCapabilities', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to null if no entry exists', () => {
    expect(getDeliveryCapability('https://example.com/stream.m3u8', 'TestProv')).toBe(null);
  });

  it('stores and retrieves capability correctly', () => {
    setDeliveryCapability('https://example.com/video.mp4', 'direct_ok', 'TestProv');
    expect(getDeliveryCapability('https://example.com/video.mp4', 'TestProv')).toBe('direct_ok');
  });

  it('expires direct_ok capability after TTL', () => {
    setDeliveryCapability('https://example.com/video.mp4', 'direct_ok', 'TestProv');
    expect(getDeliveryCapability('https://example.com/video.mp4', 'TestProv')).toBe('direct_ok');

    vi.advanceTimersByTime(4 * 24 * 60 * 60 * 1000); // 4 days (TTL is 3d for direct_ok)
    cleanOldCapabilities();

    expect(getDeliveryCapability('https://example.com/video.mp4', 'TestProv')).toBe(null);
  });

  it('falls back to domain base key if provider is missing', () => {
    setDeliveryCapability('https://sub.domain.com/path', 'embed_only');
    expect(getDeliveryCapability('https://sub.domain.com/other-path')).toBe('embed_only');
  });
});
