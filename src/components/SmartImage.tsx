// src/components/SmartImage.tsx
import React, { useEffect, useState } from 'react';
import { proxiedImageUrl } from '../utils/proxiedUrl';

interface SmartImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src?: string | null;
  alt: string;
  /** Elemento/envoltura que se renderiza si la imagen falla también vía proxy. */
  fallback?: React.ReactNode;
}

function isLocalSrc(src: string): boolean {
  return (
    src.startsWith('/') ||
    src.startsWith('data:') ||
    src.startsWith('blob:') ||
    src.includes('localhost') ||
    src.includes('127.0.0.1')
  );
}

/**
 * <img> tolerante a CORS: los CDNs de metadatos (s4.anilist.co, kitsu.app,
 * wikimedia...) no siempre sirven Access-Control-Allow-Origin y llenan la
 * consola de errores dejando huecos en la UI. Al fallar la carga directa,
 * reintenta una vez vía el proxy del backend (/api/v1/proxy/stream) antes de
 * rendirse con el fallback.
 */
export const SmartImage = React.forwardRef<HTMLImageElement, SmartImageProps>(
  ({ src, alt, fallback = null, onError, ...rest }, ref) => {
    const [stage, setStage] = useState<'direct' | 'proxy' | 'failed'>('direct');

    // Reset al cambiar la fuente (navegación entre títulos)
    useEffect(() => {
      setStage(src ? 'direct' : 'failed');
    }, [src]);

    if (!src || stage === 'failed') return <>{fallback}</>;

    if (stage === 'proxy' && !isLocalSrc(src)) {
      return (
        <img
          ref={ref}
          src={proxiedImageUrl(src)}
          alt={alt}
          onError={(e) => {
            setStage('failed');
            onError?.(e);
          }}
          {...rest}
        />
      );
    }

    return (
      <img
        ref={ref}
        src={src}
        alt={alt}
        loading={rest.loading ?? 'lazy'}
        onError={(e) => {
          if (isLocalSrc(src)) {
            setStage('failed');
          } else {
            setStage('proxy');
          }
          onError?.(e);
        }}
        {...rest}
      />
    );
  }
);

SmartImage.displayName = 'SmartImage';
