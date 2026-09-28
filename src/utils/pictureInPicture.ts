export function isPictureInPictureSupported(
  video: Pick<HTMLVideoElement, 'requestPictureInPicture'> | null | undefined,
  documentEnabled: boolean,
): boolean {
  return documentEnabled && typeof video?.requestPictureInPicture === 'function';
}
