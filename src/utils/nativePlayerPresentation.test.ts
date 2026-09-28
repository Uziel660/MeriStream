import { describe, expect, it, vi } from 'vitest';
import { createNativePlayerPresentationController } from './nativePlayerPresentation';

describe('native player presentation lifecycle', () => {
  it('keeps playback immersive without re-hiding system bars or re-locking orientation on resume', async () => {
    const setSystemBarsHidden = vi.fn(async (_hidden: boolean) => {});
    const lockLandscape = vi.fn(async () => {});
    const unlockOrientation = vi.fn(async () => {});
    const onFullscreenChange = vi.fn();
    const player = createNativePlayerPresentationController({
      setSystemBarsHidden,
      lockLandscape,
      unlockOrientation,
      onFullscreenChange,
    });

    await player.open();
    await player.enterFullscreen();
    await player.enterFullscreen();

    expect(setSystemBarsHidden.mock.calls).toEqual([[true]]);
    expect(lockLandscape).toHaveBeenCalledOnce();
    expect(unlockOrientation).not.toHaveBeenCalled();
    expect(onFullscreenChange.mock.calls).toEqual([[true]]);
  });

  it('restores system bars for an overlay, then hides them once when the overlay closes', async () => {
    const setSystemBarsHidden = vi.fn(async (_hidden: boolean) => {});
    const lockLandscape = vi.fn(async () => {});
    const unlockOrientation = vi.fn(async () => {});
    const onFullscreenChange = vi.fn();
    const player = createNativePlayerPresentationController({
      setSystemBarsHidden,
      lockLandscape,
      unlockOrientation,
      onFullscreenChange,
    });

    await player.open();
    await player.setOverlayVisible(true);
    await player.setOverlayVisible(false);

    expect(setSystemBarsHidden.mock.calls).toEqual([[true], [false], [true]]);
    expect(lockLandscape).toHaveBeenCalledOnce();
    expect(unlockOrientation).not.toHaveBeenCalled();
    expect(onFullscreenChange.mock.calls).toEqual([[true]]);
  });

  it('keeps fullscreen off when the More sheet closes after the user exits fullscreen', async () => {
    const setSystemBarsHidden = vi.fn(async (_hidden: boolean) => {});
    const lockLandscape = vi.fn(async () => {});
    const unlockOrientation = vi.fn(async () => {});
    const onFullscreenChange = vi.fn();
    const player = createNativePlayerPresentationController({
      setSystemBarsHidden,
      lockLandscape,
      unlockOrientation,
      onFullscreenChange,
    });

    await player.open();
    await player.setOverlayVisible(true);
    await player.leaveFullscreen();
    await player.setOverlayVisible(false);

    expect(setSystemBarsHidden.mock.calls).toEqual([[true], [false]]);
    expect(lockLandscape).toHaveBeenCalledOnce();
    expect(unlockOrientation).toHaveBeenCalledOnce();
    expect(onFullscreenChange.mock.calls).toEqual([[true], [false]]);
  });

  it('stays immersive when fullscreen is re-entered after closing the More sheet', async () => {
    const setSystemBarsHidden = vi.fn(async (_hidden: boolean) => {});
    const lockLandscape = vi.fn(async () => {});
    const unlockOrientation = vi.fn(async () => {});
    const onFullscreenChange = vi.fn();
    const player = createNativePlayerPresentationController({
      setSystemBarsHidden,
      lockLandscape,
      unlockOrientation,
      onFullscreenChange,
    });

    await player.open();
    await player.setOverlayVisible(true);
    await player.leaveFullscreen();
    await player.setOverlayVisible(false);
    await player.enterFullscreen();
    await player.setOverlayVisible(false);

    expect(setSystemBarsHidden.mock.calls).toEqual([[true], [false], [true]]);
    expect(lockLandscape).toHaveBeenCalledTimes(2);
    expect(unlockOrientation).toHaveBeenCalledOnce();
    expect(onFullscreenChange.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('reports whether a system bar transition is caused by an overlay or leaving fullscreen', async () => {
    const onStateChange = vi.fn();
    const player = createNativePlayerPresentationController({
      setSystemBarsHidden: vi.fn(async () => {}),
      lockLandscape: vi.fn(async () => {}),
      unlockOrientation: vi.fn(async () => {}),
      onStateChange,
    });

    await player.open();
    await player.setOverlayVisible(true);
    await player.setOverlayVisible(false);

    expect(onStateChange.mock.calls.map(([state]) => state)).toEqual([
      {
        isOpen: true,
        isFullscreen: true,
        isOverlayVisible: false,
        shouldHideBars: true,
        shouldLockOrientation: true,
      },
      {
        isOpen: true,
        isFullscreen: true,
        isOverlayVisible: true,
        shouldHideBars: false,
        shouldLockOrientation: true,
      },
      {
        isOpen: true,
        isFullscreen: true,
        isOverlayVisible: false,
        shouldHideBars: true,
        shouldLockOrientation: true,
      },
    ]);
  });

  it('drops stale native presentation transitions while a slow plugin call is pending', async () => {
    const systemBarTransitions: boolean[] = [];
    let releaseFirstTransition: (() => void) | undefined;
    const firstTransitionPending = new Promise<void>((resolve) => {
      releaseFirstTransition = resolve;
    });
    const setSystemBarsHidden = vi.fn(async (hidden: boolean) => {
      systemBarTransitions.push(hidden);
      if (systemBarTransitions.length === 1) await firstTransitionPending;
    });
    const lockLandscape = vi.fn(async () => {});
    const unlockOrientation = vi.fn(async () => {});
    const player = createNativePlayerPresentationController({
      setSystemBarsHidden,
      lockLandscape,
      unlockOrientation,
      onFullscreenChange: vi.fn(),
    });

    const opened = player.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(systemBarTransitions).toEqual([true]);

    void player.setOverlayVisible(true);
    void player.setOverlayVisible(false);
    void player.leaveFullscreen();
    void player.setOverlayVisible(false);
    const reentered = player.enterFullscreen();

    releaseFirstTransition?.();
    await Promise.all([opened, reentered]);

    expect(systemBarTransitions).toEqual([true]);
    expect(lockLandscape).toHaveBeenCalledOnce();
    expect(unlockOrientation).not.toHaveBeenCalled();
  });

  it('closes idempotently after fullscreen was already left', async () => {
    const setSystemBarsHidden = vi.fn(async (_hidden: boolean) => {});
    const lockLandscape = vi.fn(async () => {});
    const unlockOrientation = vi.fn(async () => {});
    const player = createNativePlayerPresentationController({
      setSystemBarsHidden,
      lockLandscape,
      unlockOrientation,
      onFullscreenChange: vi.fn(),
    });

    await player.open();
    await player.leaveFullscreen();
    await player.close();
    await player.close();

    expect(setSystemBarsHidden.mock.calls).toEqual([[true], [false]]);
    expect(unlockOrientation).toHaveBeenCalledOnce();
  });
});
