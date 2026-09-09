import { describe, expect, it } from 'vitest';
import { cardPosterSrcSet, cardPosterUrl, heroBackdropSrcSet } from './imageSizes';

describe('card poster selection', () => {
  it('skips a title-art PNG and keeps a valid poster fallback', () => {
    const media = {
      poster_url: 'https://image.tmdb.org/t/p/w500/title-art.png',
      banner_url: 'https://image.tmdb.org/t/p/w1280/backdrop.jpg',
      poster_path: null,
      backdrop_path: null,
    };

    expect(cardPosterUrl(media)).toContain('/w342/backdrop.jpg');
    expect(cardPosterUrl(media)).not.toMatch(/\.png/i);
    expect(cardPosterSrcSet(media)).toContain('/w342/backdrop.jpg');
  });

  it('does not generate a PNG srcset when TMDB poster_path is title art', () => {
    const media = {
      poster_path: '/title-art.png',
      poster_url: 'https://image.tmdb.org/t/p/w500/title-art.png',
      banner_url: 'https://image.tmdb.org/t/p/w1280/backdrop.jpg',
    };

    expect(cardPosterUrl(media)).toContain('/w342/backdrop.jpg');
    expect(cardPosterSrcSet(media)).not.toMatch(/title-art\.png/i);
  });
});

describe('hero backdrop selection', () => {
  it('offers the original TMDB asset for large displays', () => {
    const srcSet = heroBackdropSrcSet({ backdrop_path: '/backdrop.jpg' });

    expect(srcSet).toContain('/w1280/backdrop.jpg 1280w');
    expect(srcSet).toContain('/original/backdrop.jpg 1920w');
  });
});
