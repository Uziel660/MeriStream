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
