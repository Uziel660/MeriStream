import { OpenSubtitlesProvider } from "./providers/OpenSubtitlesProvider";
import { TvSubtitlesProvider } from "./providers/TvSubtitlesProvider";
import { YifySubtitlesProvider } from "./providers/YifySubtitlesProvider";
import { SubtitleCatProvider } from "./providers/SubtitleCatProvider";
import { SubtitleGateway } from "./SubtitleGateway";
import { subtitleRouter } from "./SubtitleRouter";

export const subtitleGateway = new SubtitleGateway([
  new OpenSubtitlesProvider(),
  new TvSubtitlesProvider(),
  new YifySubtitlesProvider(),
  new SubtitleCatProvider(),
]);

export { SubtitleGateway } from "./SubtitleGateway";
export { subtitleRouter } from "./SubtitleRouter";
export * from "./types";
