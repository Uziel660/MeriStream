import { describe, expect, it } from 'vitest';
import {
  sizedImageUrl,
  tmdbImageUrl,
  heroBackdropUrl,
  bentoBackdropUrl,
  cardPosterUrl,
  cardPosterSrcSet,
  heroBackdropSrcSet,
  thumbBackdropUrl,
  type ImageSourceMedia
} from './imageSizes';

describe('sizedImageUrl', () => {
  it('correctly resizes a standard TMDB image URL', () => {
    expect(sizedImageUrl('https://image.tmdb.org/t/p/w500/abcd.jpg', 'w342')).toBe('https://image.tmdb.org/t/p/w342/abcd.jpg');
  });

  it('preserves query parameters if any', () => {
    expect(sizedImageUrl('https://image.tmdb.org/t/p/w500/abcd.jpg?api_key=123', 'w185')).toBe('https://image.tmdb.org/t/p/w185/abcd.jpg?api_key=123');
  });

  it('handles resizing from original size', () => {
    expect(sizedImageUrl('https://image.tmdb.org/t/p/original/efgh.png', 'w780')).toBe('https://image.tmdb.org/t/p/w780/efgh.png');
  });

  it('returns null for invalid or empty inputs', () => {
    expect(sizedImageUrl(null, 'w342')).toBeNull();
    expect(sizedImageUrl(undefined, 'w342')).toBeNull();
    expect(sizedImageUrl('', 'w342')).toBeNull();
    expect(sizedImageUrl('   ', 'w342')).toBeNull();
  });
});

describe('tmdbImageUrl', () => {
  it('correctly prepends the TMDB base URL to a valid path', () => {
    expect(tmdbImageUrl('/path123.jpg', 'w1280')).toBe('https://image.tmdb.org/t/p/w1280/path123.jpg');
  });

  it('returns null for missing paths or paths not starting with /', () => {
    expect(tmdbImageUrl(null, 'w1280')).toBeNull();
    expect(tmdbImageUrl(undefined, 'w1280')).toBeNull();
    expect(tmdbImageUrl('', 'w1280')).toBeNull();
    expect(tmdbImageUrl('path123.jpg', 'w1280')).toBeNull();
  });
});

describe('Layout Helpers', () => {
  const mediaWithAll: ImageSourceMedia = {
    backdrop_path: '/backdrop.jpg',
    poster_path: '/poster.jpg',
    banner_url: 'https://image.tmdb.org/t/p/original/banner_full.jpg',
    backdrop_url: 'https://image.tmdb.org/t/p/original/backdrop_full.jpg',
    poster_url: 'https://image.tmdb.org/t/p/original/poster_full.jpg'
  };

  const mediaWithUrlsOnly: ImageSourceMedia = {
    banner_url: 'https://image.tmdb.org/t/p/original/banner_full.jpg',
    backdrop_url: 'https://image.tmdb.org/t/p/original/backdrop_full.jpg',
    poster_url: 'https://image.tmdb.org/t/p/original/poster_full.jpg'
  };

  describe('heroBackdropUrl', () => {
    it('prioritizes backdrop_path and uses w1280', () => {
      expect(heroBackdropUrl(mediaWithAll)).toBe('https://image.tmdb.org/t/p/w1280/backdrop.jpg');
    });

    it('falls back to banner_url if backdrop_path is missing', () => {
      expect(heroBackdropUrl(mediaWithUrlsOnly)).toBe('https://image.tmdb.org/t/p/w1280/banner_full.jpg');
    });

    it('returns null if no image sources are available', () => {
      expect(heroBackdropUrl({})).toBeNull();
    });
  });

  describe('bentoBackdropUrl', () => {
    it('prioritizes backdrop_path and uses w1280', () => {
      expect(bentoBackdropUrl(mediaWithAll)).toBe('https://image.tmdb.org/t/p/w1280/backdrop.jpg');
    });

    it('returns null if no image sources are available', () => {
      expect(bentoBackdropUrl({})).toBeNull();
    });
  });

  describe('cardPosterUrl', () => {
    it('prioritizes poster_path and uses w342', () => {
      expect(cardPosterUrl(mediaWithAll)).toBe('https://image.tmdb.org/t/p/w342/poster.jpg');
    });

    it('falls back to poster_url if poster_path is missing', () => {
      expect(cardPosterUrl(mediaWithUrlsOnly)).toBe('https://image.tmdb.org/t/p/w342/poster_full.jpg');
    });

    it('returns null if no image sources are available', () => {
      expect(cardPosterUrl({})).toBeNull();
    });
  });

  describe('thumbBackdropUrl', () => {
    it('prioritizes backdrop_path and uses w780', () => {
      expect(thumbBackdropUrl(mediaWithAll)).toBe('https://image.tmdb.org/t/p/w780/backdrop.jpg');
    });

    it('falls back to backdrop_url if backdrop_path is missing', () => {
      // Create a specific object without backdrop_path to test the fallback properly
      const m = { backdrop_url: 'https://image.tmdb.org/t/p/original/backdrop_full.jpg' };
      expect(thumbBackdropUrl(m)).toBe('https://image.tmdb.org/t/p/w780/backdrop_full.jpg');
    });

    it('returns null if no image sources are available', () => {
      expect(thumbBackdropUrl({})).toBeNull();
    });
  });
});

describe('responsive image selection', () => {
  it('skips title art and keeps a valid poster fallback', () => {
    const media = {
      poster_url: 'https://image.tmdb.org/t/p/w500/title-art.png',
      banner_url: 'https://image.tmdb.org/t/p/w1280/backdrop.jpg',
      poster_path: null,
      backdrop_path: null,
    };

    expect(cardPosterUrl(media)).toContain('/w342/backdrop.jpg');
    expect(cardPosterUrl(media)).not.toMatch(/\.png/i);
    expect(cardPosterSrcSet(media)).toContain('/w342/backdrop.jpg');
    expect(cardPosterSrcSet(media)).toContain('/w780/backdrop.jpg 780w');
    expect(cardPosterSrcSet(media)).not.toContain('/w185/');
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

  it('offers the original TMDB backdrop for large displays', () => {
    const srcSet = heroBackdropSrcSet({ backdrop_path: '/backdrop.jpg' });

    expect(srcSet).toContain('/w1280/backdrop.jpg 1280w');
    expect(srcSet).toContain('/original/backdrop.jpg 1920w');
  });
});
