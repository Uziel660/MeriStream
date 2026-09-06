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

    useEffect(() => {
      setFailed(!src);
    }, [src]);

    if (!src || failed) return <>{fallback}</>;

    return (
      <img
        ref={ref}
        src={src}
        alt={alt}
        loading={rest.loading ?? 'lazy'}
        onError={(e) => {
          setFailed(true);
          onError?.(e);
        }}
        {...rest}
      />
    );
  }
);

SmartImage.displayName = 'SmartImage';
