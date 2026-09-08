// src/components/SmartImage.tsx
import React, { useEffect, useState } from 'react';

interface SmartImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src?: string | null;
  alt: string;
  fallback?: React.ReactNode;
}

/**
 * <img> optimizado: carga directa desde CDN. Si falla (CORS), muestra fallback
 * inmediatamente sin intentar proxy. Esto reduce requests de 2-3x a 1x por imagen.
 */
export const SmartImage = React.forwardRef<HTMLImageElement, SmartImageProps>(
  ({ src, alt, fallback = null, onError, ...rest }, ref) => {
    const [failed, setFailed] = useState(false);
    // React 19 warns when `fetchPriority` is forwarded to the DOM by this
    // wrapper. Keep the hint for callers' type compatibility while omitting
    // it from the rendered element; lazy loading/decoding provide the same
    // low-end-device behaviour without a console warning.
    const { fetchPriority, ...safeRest } = rest;
    void fetchPriority;

    useEffect(() => {
      setFailed(!src);
    }, [src]);

    if (!src || failed) return <>{fallback}</>;

    return (
      <img
        ref={ref}
        src={src}
        alt={alt}
        loading={safeRest.loading ?? 'lazy'}
        decoding={safeRest.decoding ?? 'async'}
        onError={(e) => {
          setFailed(true);
          onError?.(e);
        }}
        {...safeRest}
      />
    );
  }
);

SmartImage.displayName = 'SmartImage';
