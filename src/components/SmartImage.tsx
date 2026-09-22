// src/components/SmartImage.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { proxiedImageUrl } from '../utils/proxiedUrl';

interface SmartImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src?: string | null;
  /** Ordered alternatives tried only after the current image fails. */
  sources?: string[];
  alt: string;
  fallback?: React.ReactNode;
}

/**
 * <img> resiliente: intenta la imagen directa, después su proxy same-origin y
 * finalmente las alternativas proporcionadas por la tarjeta. Las alternativas
 * no se precargan; solo se piden cuando la anterior falla.
 */
export const SmartImage = React.forwardRef<HTMLImageElement, SmartImageProps>(
  ({ src, sources = [], alt, fallback = null, onError, srcSet, ...rest }, ref) => {
    const [failed, setFailed] = useState(false);
    const [sourceIndex, setSourceIndex] = useState(0);
    // Preserve the browser's priority hint. The hero relies on
    // `fetchPriority="high"` to make its LCP image discoverable immediately;
    // dropping it inside this resilience wrapper silently defeated that hint.
    const { fetchPriority, ...safeRest } = rest;

    const sourceSignature = [src || '', ...sources].join('\u0001');
    const candidateSources = useMemo(() => {
      const candidates: string[] = [];
      const add = (value: string | null | undefined) => {
        const normalized = String(value || '').trim();
        if (!normalized || candidates.includes(normalized)) return;
        candidates.push(normalized);
      };
      [src, ...sources].forEach((value) => {
        add(value);
        const proxied = value ? proxiedImageUrl(String(value)) : '';
        if (proxied && proxied !== value) add(proxied);
      });
      return candidates;
    }, [sourceSignature]);

    useEffect(() => {
      setFailed(candidateSources.length === 0);
      setSourceIndex(0);
    }, [sourceSignature, candidateSources.length]);

    const activeSrc = candidateSources[sourceIndex];

    if (!activeSrc || failed) return <>{fallback}</>;

    return (
      <img
        ref={ref}
        src={activeSrc}
        alt={alt}
        loading={safeRest.loading ?? 'lazy'}
        decoding={safeRest.decoding ?? 'async'}
        fetchPriority={fetchPriority}
        srcSet={sourceIndex === 0 ? srcSet : undefined}
        onError={(event) => {
          if (sourceIndex < candidateSources.length - 1) {
            setSourceIndex((current) => Math.min(current + 1, candidateSources.length - 1));
          } else {
            setFailed(true);
          }
          onError?.(event);
        }}
        {...safeRest}
      />
    );
  }
);

SmartImage.displayName = 'SmartImage';
