export interface NativePlayerPresentationPort {
  setSystemBarsHidden: (hidden: boolean) => void | Promise<void>;
  lockLandscape: () => void | Promise<void>;
  unlockOrientation: () => void | Promise<void>;
  onFullscreenChange?: (fullscreen: boolean) => void;
  onStateChange?: (state: NativePlayerPresentationState) => void;
}

export interface NativePlayerPresentationState {
  isOpen: boolean;
  isFullscreen: boolean;
  isOverlayVisible: boolean;
  shouldHideBars: boolean;
  shouldLockOrientation: boolean;
}

export interface NativePlayerPresentationController {
  open: (overlayVisible?: boolean) => Promise<void>;
  enterFullscreen: () => Promise<void>;
  leaveFullscreen: () => Promise<void>;
  setOverlayVisible: (visible: boolean) => Promise<void>;
  close: () => Promise<void>;
}

export function createNativePlayerPresentationController(
  port: NativePlayerPresentationPort,
): NativePlayerPresentationController {
  let isOpen = false;
  let isFullscreen = false;
  let isOverlayVisible = false;
  let barsHidden: boolean | null = null;
  let orientationLocked = false;
  let barsTransitions = Promise.resolve();
  let orientationTransitions = Promise.resolve();
  let isReconcilingBars = false;
  let isReconcilingOrientation = false;
  let desiredVersion = 0;

  const sync = () => {
    const shouldHideBars = isOpen && isFullscreen && !isOverlayVisible;
    const shouldLockOrientation = isOpen && isFullscreen;
    port.onStateChange?.({
      isOpen,
      isFullscreen,
      isOverlayVisible,
      shouldHideBars,
      shouldLockOrientation,
    });

    desiredVersion += 1;
    if (!isReconcilingBars) {
      isReconcilingBars = true;
      barsTransitions = barsTransitions.then(async () => {
        try {
          while (true) {
            const version = desiredVersion;
            const nextBarsHidden = isOpen && isFullscreen && !isOverlayVisible;
            if (barsHidden !== nextBarsHidden) {
              barsHidden = nextBarsHidden;
              try {
                await port.setSystemBarsHidden(nextBarsHidden);
              } catch {
                // Keep the last requested state; callers can retry on the next state change.
              }
            }

            if (version === desiredVersion) return;
          }
        } finally {
          isReconcilingBars = false;
        }
      }).catch(() => undefined);
    }

    if (!isReconcilingOrientation) {
      isReconcilingOrientation = true;
      orientationTransitions = orientationTransitions.then(async () => {
        try {
          while (true) {
            const version = desiredVersion;
            const nextOrientationLocked = isOpen && isFullscreen;
            if (orientationLocked !== nextOrientationLocked) {
              orientationLocked = nextOrientationLocked;
              try {
                if (nextOrientationLocked) await port.lockLandscape();
                else await port.unlockOrientation();
              } catch {
                // Keep the last requested state; callers can retry on the next state change.
              }
            }

            if (version === desiredVersion) return;
          }
        } finally {
          isReconcilingOrientation = false;
        }
      }).catch(() => undefined);
    }

    // System-bar changes must not wait for orientation operations: on low-end
    // Android devices an unlock can take long enough to leave the bars visible
    // after the player has already re-entered fullscreen.
    return Promise.all([barsTransitions, orientationTransitions]).then(() => undefined);
  };

  const setFullscreen = (fullscreen: boolean) => {
    if (isFullscreen !== fullscreen) {
      isFullscreen = fullscreen;
      port.onFullscreenChange?.(fullscreen);
    }
    return sync();
  };

  return {
    open(overlayVisible = false) {
      isOpen = true;
      isOverlayVisible = overlayVisible;
      return setFullscreen(true);
    },
    enterFullscreen() {
      isOpen = true;
      return setFullscreen(true);
    },
    leaveFullscreen() {
      return setFullscreen(false);
    },
    setOverlayVisible(visible: boolean) {
      isOverlayVisible = visible;
      return sync();
    },
    close() {
      isOpen = false;
      isOverlayVisible = false;
      return setFullscreen(false);
    },
  };
}
