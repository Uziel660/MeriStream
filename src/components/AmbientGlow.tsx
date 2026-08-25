// src/components/AmbientGlow.tsx
import React, { useEffect, useState } from 'react';
import { rgbToRgbaString } from '../utils/colorExtractor';

interface AmbientGlowProps {
  dominantRgb: [number, number, number];
}

export const AmbientGlow: React.FC<AmbientGlowProps> = ({ dominantRgb }) => {
  const [currentRgb, setCurrentRgb] = useState<[number, number, number]>(dominantRgb);

  useEffect(() => {
    setCurrentRgb(dominantRgb);
  }, [dominantRgb]);

  const glowRgba = rgbToRgbaString(currentRgb, 0.16);
  const secondaryGlowRgba = rgbToRgbaString(currentRgb, 0.08);

  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 pointer-events-none z-0 overflow-hidden transition-all duration-1000 ease-out"
      style={{
        background: `
          radial-gradient(circle at 80% 15%, ${glowRgba} 0%, transparent 60%),
          radial-gradient(circle at 20% 85%, ${secondaryGlowRgba} 0%, transparent 50%)
        `,
      }}
    />
  );
};
