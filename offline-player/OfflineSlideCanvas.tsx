import { useMemo, useRef } from 'react';
import { AnimatePresence } from 'motion/react';
import { LaserOverlay } from '@/components/slide-renderer/Editor/LaserOverlay';
import { SpotlightOverlay } from '@/components/slide-renderer/Editor/SpotlightOverlay';
import { useSceneSelector } from '@/lib/contexts/scene-context';
import { useSlideBackgroundStyle } from '@/lib/hooks/use-slide-background-style';
import { useCanvasStore } from '@/lib/store/canvas';
import { findElementGeometry } from '@/lib/utils/geometry';
import type { PercentageGeometry } from '@/lib/types/action';
import type { PPTElement, SlideBackground } from '@/lib/types/slides';
import type { SlideContent } from '@/lib/types/stage';
import { useOfflineViewportSize } from './hooks/useOfflineViewportSize';
import { OfflineHighlightOverlay } from './overlays/OfflineHighlightOverlay';
import { OfflineScreenElement } from './OfflineScreenElement';

export function OfflineSlideCanvas() {
  const canvasScale = useCanvasStore.use.canvasScale();
  const elements = useSceneSelector<SlideContent, PPTElement[]>((content) => content.canvas.elements);
  const canvasRef = useRef<HTMLDivElement>(null);
  const { viewportStyles } = useOfflineViewportSize(canvasRef);
  const background = useSceneSelector<SlideContent, SlideBackground | undefined>(
    (content) => content.canvas.background,
  );
  const { backgroundStyle } = useSlideBackgroundStyle(background);
  const laserElementId = useCanvasStore.use.laserElementId();
  const laserOptions = useCanvasStore.use.laserOptions();
  const zoomTarget = useCanvasStore.use.zoomTarget();

  const laserGeometry = useMemo<PercentageGeometry | null>(() => {
    if (!laserElementId) return null;
    return findElementGeometry(
      { type: 'slide', content: { canvas: { elements } } } as Record<string, unknown>,
      laserElementId,
    );
  }, [laserElementId, elements]);

  const zoomGeometry = useMemo<PercentageGeometry | null>(() => {
    if (!zoomTarget) return null;
    return findElementGeometry(
      { type: 'slide', content: { canvas: { elements } } } as Record<string, unknown>,
      zoomTarget.elementId,
    );
  }, [zoomTarget, elements]);

  return (
    <div className="relative h-full w-full overflow-hidden select-none" ref={canvasRef}>
      <div
        className="absolute rounded-lg overflow-hidden transition-transform duration-700 omaic-slide-frame"
        style={{
          width: `${viewportStyles.width * canvasScale}px`,
          height: `${viewportStyles.height * canvasScale}px`,
          left: `${viewportStyles.left}px`,
          top: `${viewportStyles.top}px`,
          ...(zoomTarget && zoomGeometry
            ? {
                transform: `scale(${zoomTarget.scale})`,
                transformOrigin: `${zoomGeometry.centerX}% ${zoomGeometry.centerY}%`,
              }
            : {}),
        }}
      >
        <div className="w-full h-full bg-position-center rounded-lg" style={backgroundStyle} />
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width: `${viewportStyles.width}px`,
            height: `${viewportStyles.height}px`,
            transform: `scale(${canvasScale})`,
          }}
        >
          {elements.map((element, index) => (
            <OfflineScreenElement key={element.id} elementInfo={element} elementIndex={index + 1} />
          ))}
          <OfflineHighlightOverlay />
        </div>
        <SpotlightOverlay />
        <div className="absolute inset-0 pointer-events-none" style={{ padding: '5%' }}>
          <div className="relative w-full h-full">
            <AnimatePresence>
              {laserElementId && laserGeometry && (
                <LaserOverlay
                  key={`laser-${laserElementId}`}
                  geometry={laserGeometry}
                  color={laserOptions?.color}
                  duration={laserOptions?.duration}
                />
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
