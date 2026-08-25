// src/utils/colorExtractor.ts
import { proxiedImageUrl } from './proxiedUrl';

export { proxiedImageUrl };

// Fallback palette palette based on string hash if image CORS prevents canvas extraction
const PRESET_VIBRANT_COLORS: [number, number, number][] = [
  [245, 158, 11],  // Warm Amber
  [217, 70, 239],  // Magenta / Anime Violet
  [14, 165, 233],  // Sky Blue
  [239, 68, 68],   // Crimson Red
  [16, 185, 129],  // Emerald Green
  [249, 115, 22],  // Orange
  [168, 85, 247],  // Purple
  [236, 72, 153],  // Pink
];

const colorCache = new Map<string, [number, number, number]>();

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('load error'));
    img.src = url;
  });
}

export async function extractDominantColor(imageUrl?: string | null, fallbackKey?: string): Promise<[number, number, number]> {
  if (!imageUrl) {
    return getFallbackColor(fallbackKey || 'default');
  }

  if (colorCache.has(imageUrl)) {
    return colorCache.get(imageUrl)!;
  }

  let img: HTMLImageElement | null = null;
  try {
    img = await withTimeout(loadImage(imageUrl));
  } catch {
    try {
      img = await withTimeout(loadImage(proxiedImageUrl(imageUrl)));
    } catch {
      const fallback = getFallbackColor(fallbackKey || imageUrl);
      colorCache.set(imageUrl, fallback);
      return fallback;
    }
  }

  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      const fallback = getFallbackColor(fallbackKey || imageUrl);
      colorCache.set(imageUrl, fallback);
      return fallback;
    }

    // Downscale for performance
    canvas.width = 30;
    canvas.height = 30;
    ctx.drawImage(img, 0, 0, 30, 30);
    const imgData = ctx.getImageData(0, 0, 30, 30).data;

    let r = 0, g = 0, b = 0, count = 0;
    let maxSaturation = -1;
    let bestRgb: [number, number, number] = [245, 158, 11];

    for (let i = 0; i < imgData.length; i += 16) {
      const pr = imgData[i];
      const pg = imgData[i + 1];
      const pb = imgData[i + 2];
      const pa = imgData[i + 3];

      // Skip transparent or near-black / near-white
      if (pa < 128) continue;
      const brightness = (pr + pg + pb) / 3;
      if (brightness < 30 || brightness > 235) continue;

      // Compute saturation
      const max = Math.max(pr, pg, pb);
      const min = Math.min(pr, pg, pb);
      const saturation = max === 0 ? 0 : (max - min) / max;

      if (saturation > maxSaturation) {
        maxSaturation = saturation;
        bestRgb = [pr, pg, pb];
      }

      r += pr;
      g += pg;
      b += pb;
      count++;
    }

    const chosenColor = maxSaturation > 0.25 ? bestRgb : (count > 0 ? [Math.round(r / count), Math.round(g / count), Math.round(b / count)] as [number, number, number] : getFallbackColor(fallbackKey || imageUrl));
    colorCache.set(imageUrl, chosenColor);
    return chosenColor;
  } catch {
    const fallback = getFallbackColor(fallbackKey || imageUrl);
    colorCache.set(imageUrl, fallback);
    return fallback;
  }
}

function withTimeout(load: Promise<HTMLImageElement>, timeoutMs = 1200): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    load.then(
      (img) => {
        clearTimeout(timer);
        resolve(img);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function getFallbackColor(key: string): [number, number, number] {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % PRESET_VIBRANT_COLORS.length;
  return PRESET_VIBRANT_COLORS[index];
}

export function rgbToRgbaString(rgb: [number, number, number], alpha: number): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}
