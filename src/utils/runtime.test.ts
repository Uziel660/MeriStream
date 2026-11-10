import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeOnAppResume } from './runtime';

describe('native app resume subscription', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses Capacitor appStateChange and removes the listener on cleanup', async () => {
    let onAppStateChange: ((state: { isActive?: boolean }) => void) | undefined;
    const remove = vi.fn(async () => {});
    const addListener = vi.fn(async (_event: string, listener: typeof onAppStateChange) => {
      onAppStateChange = listener;
      return { remove };
    });
    vi.stubGlobal('window', {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { App: { addListener } },
      },
    });
    const onResume = vi.fn();

    const cleanup = nativeOnAppResume(onResume);
    await Promise.resolve();
    await Promise.resolve();
    onAppStateChange?.({ isActive: false });
    onAppStateChange?.({ isActive: true });

    expect(addListener).toHaveBeenCalledOnce();
    expect(onResume).toHaveBeenCalledOnce();
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(remove).toHaveBeenCalledOnce();
  });

  it('removes an app listener whose registration resolves after cleanup', async () => {
    type ListenerHandle = { remove: () => Promise<void> };
    let resolveRegistration: ((listener: ListenerHandle) => void) | undefined;
    const remove = vi.fn(async () => {});
    const addListener = vi.fn(() => new Promise<ListenerHandle>((resolve) => {
      resolveRegistration = resolve;
    }));
    vi.stubGlobal('window', {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { App: { addListener } },
      },
    });

    const cleanup = nativeOnAppResume(vi.fn());
    await Promise.resolve();
    cleanup();
    resolveRegistration?.({ remove });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(remove).toHaveBeenCalledOnce();
  });

  it('falls back to visible document state when the Capacitor app listener is unavailable', () => {
    const listeners = new Map<string, EventListener>();
    const documentMock = {
      visibilityState: 'hidden',
      addEventListener: vi.fn((event: string, listener: EventListener) => listeners.set(event, listener)),
      removeEventListener: vi.fn((event: string) => listeners.delete(event)),
    };
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true, Plugins: {} } });
    vi.stubGlobal('document', documentMock);
    const onResume = vi.fn();

    const cleanup = nativeOnAppResume(onResume);
    listeners.get('visibilitychange')?.(new Event('visibilitychange'));
    documentMock.visibilityState = 'visible';
    listeners.get('visibilitychange')?.(new Event('visibilitychange'));

    expect(onResume).toHaveBeenCalledOnce();
    cleanup();
    expect(documentMock.removeEventListener).toHaveBeenCalledOnce();
  });
});
