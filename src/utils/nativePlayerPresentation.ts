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
  let transitions = Promise.resolve();

  const enqueue = (transition: () => void | Promise<void>) => {
    transitions = transitions.then(transition).catch(() => undefined);
    return transitions;
  };

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

    if (barsHidden !== shouldHideBars) {
      barsHidden = shouldHideBars;
      void enqueue(() => port.setSystemBarsHidden(shouldHideBars));
    }

    if (orientationLocked !== shouldLockOrientation) {
      orientationLocked = shouldLockOrientation;
      void enqueue(() => shouldLockOrientation ? port.lockLandscape() : port.unlockOrientation());
    }

    return transitions;
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
