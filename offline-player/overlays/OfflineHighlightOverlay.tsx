import { useMemo } from 'react';
import { useSceneSelector } from '@/lib/contexts/scene-context';
import { useCanvasStore } from '@/lib/store/canvas';
import type { PPTElement } from '@/lib/types/slides';
import type { SlideContent } from '@/lib/types/stage';

export function OfflineHighlightOverlay() {
  const highlightedElementIds = useCanvasStore.use.highlightedElementIds();
  const highlightOptions = useCanvasStore.use.highlightOptions();
  const elements = useSceneSelector<SlideContent, PPTElement[]>((content) => content.canvas.elements);

  const highlightedElements = useMemo(() => {
    if (!highlightedElementIds.length) return [];
    return elements.filter((el) => highlightedElementIds.includes(el.id) && el.type !== 'line');
  }, [elements, highlightedElementIds]);

  if (!highlightedElements.length || !highlightOptions) return null;

  const { color = '#ff6b6b', opacity = 0.3, borderWidth = 3, animated = true } = highlightOptions;

  return (
    <>
      {highlightedElements.map((element) => {
        const height = 'height' in element ? element.height : 0;
        const rotate = 'rotate' in element ? element.rotate : 0;
        return (
          <div
            key={element.id}
            className={`omaic-highlight-overlay absolute pointer-events-none ${
              animated ? 'omaic-highlight-breathe' : ''
            }`}
            style={{
              left: `${element.left}px`,
              top: `${element.top}px`,
              width: `${element.width}px`,
              height: `${height}px`,
              transform: `rotate(${rotate || 0}deg)`,
              transformOrigin: 'center',
              zIndex: 999,
              transition: 'all 0.3s ease-in-out',
            }}
          >
            <div
              className="absolute inset-0 rounded"
              style={{
                border: `${borderWidth}px solid ${color}`,
                boxShadow: `0 0 ${borderWidth * 3}px ${color}, inset 0 0 ${
                  borderWidth * 2
                }px rgba(255,255,255,${opacity * 0.5})`,
                backgroundColor: `${color}${Math.round(opacity * 255)
                  .toString(16)
                  .padStart(2, '0')}`,
              }}
            />
            {animated && (
              <div
                className="absolute inset-0 rounded omaic-highlight-ping"
                style={{
                  border: `${borderWidth}px solid ${color}`,
                  opacity: 0.5,
                }}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
