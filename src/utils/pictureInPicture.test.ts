import { describe, expect, it, vi } from 'vitest';
import { isPictureInPictureSupported } from './pictureInPicture';

describe('Picture-in-Picture action availability', () => {
  it('is unavailable when the current WebView does not enable the API', () => {
    const video = { requestPictureInPicture: vi.fn() } as unknown as HTMLVideoElement;
    expect(isPictureInPictureSupported(video, false)).toBe(false);
  });

  it('is unavailable when a video element cannot enter PiP even if the document advertises support', () => {
    expect(isPictureInPictureSupported({} as HTMLVideoElement, true)).toBe(false);
  });

  it('is available only when both the document and video support PiP', () => {
    const video = { requestPictureInPicture: vi.fn() } as unknown as HTMLVideoElement;
    expect(isPictureInPictureSupported(video, true)).toBe(true);
  });
});
