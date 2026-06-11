import { useMemo } from 'react';
import { BaseLatexElement } from '@/components/slide-renderer/components/element/LatexElement/BaseLatexElement';
import { BaseLineElement } from '@/components/slide-renderer/components/element/LineElement/BaseLineElement';
import { BaseShapeElement } from '@/components/slide-renderer/components/element/ShapeElement/BaseShapeElement';
import { BaseTableElement } from '@/components/slide-renderer/components/element/TableElement/BaseTableElement';
import { BaseTextElement } from '@/components/slide-renderer/components/element/TextElement/BaseTextElement';
import { useSceneSelector } from '@/lib/contexts/scene-context';
import { ElementTypes, type PPTElement } from '@/lib/types/slides';
import type { SceneContent } from '@/lib/types/stage';
import { OfflineImageElement } from './elements/OfflineImageElement';
import { OfflineVideoElement } from './elements/OfflineVideoElement';

interface OfflineScreenElementProps {
  readonly elementInfo: PPTElement;
  readonly elementIndex: number;
}

export function OfflineScreenElement({ elementInfo, elementIndex }: OfflineScreenElementProps) {
  const CurrentElementComponent = useMemo(() => {
    const elementTypeMap: Record<string, React.ComponentType<{ elementInfo: never }>> = {
      [ElementTypes.IMAGE]: OfflineImageElement as React.ComponentType<{ elementInfo: never }>,
      [ElementTypes.TEXT]: BaseTextElement as React.ComponentType<{ elementInfo: never }>,
      [ElementTypes.SHAPE]: BaseShapeElement as React.ComponentType<{ elementInfo: never }>,
      [ElementTypes.LINE]: BaseLineElement as React.ComponentType<{ elementInfo: never }>,
      [ElementTypes.LATEX]: BaseLatexElement as React.ComponentType<{ elementInfo: never }>,
      [ElementTypes.TABLE]: BaseTableElement as React.ComponentType<{ elementInfo: never }>,
      [ElementTypes.VIDEO]: OfflineVideoElement as React.ComponentType<{ elementInfo: never }>,
    };
    return elementTypeMap[elementInfo.type] || null;
  }, [elementInfo.type]);

  const theme = useSceneSelector<SceneContent, { fontColor: string; fontName: string }>(
    (content) => {
      if (content.type === 'slide') return content.canvas.theme;
      return { fontColor: '#333333', fontName: 'Microsoft YaHei' };
    },
  );

  if (!CurrentElementComponent) return null;

  return (
    <div
      className="screen-element"
      id={`screen-element-${elementInfo.id}`}
      style={{
        zIndex: elementIndex,
        color: theme.fontColor,
        fontFamily: theme.fontName,
      }}
    >
      <CurrentElementComponent elementInfo={elementInfo as never} />
    </div>
  );
}
