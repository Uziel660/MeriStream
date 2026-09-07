import { OpenSubtitlesProvider } from "./providers/OpenSubtitlesProvider";
import { TvSubtitlesProvider } from "./providers/TvSubtitlesProvider";
import { YifySubtitlesProvider } from "./providers/YifySubtitlesProvider";
import { SubtitleGateway } from "./SubtitleGateway";
import { subtitleRouter } from "./SubtitleRouter";

export const subtitleGateway = new SubtitleGateway([
  new OpenSubtitlesProvider(),
  new TvSubtitlesProvider(),
  new YifySubtitlesProvider(),
]);

export { SubtitleGateway } from "./SubtitleGateway";
export { subtitleRouter } from "./SubtitleRouter";
export * from "./types";
