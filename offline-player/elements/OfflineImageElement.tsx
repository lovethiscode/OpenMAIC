import type { PPTImageElement } from '@/lib/types/slides';

export function OfflineImageElement({ elementInfo }: { readonly elementInfo: PPTImageElement }) {
  const opacity = (elementInfo as PPTImageElement & { opacity?: number }).opacity;

  return (
    <div
      className="element-content absolute"
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="w-full h-full overflow-hidden"
        style={{
          transform: `rotate(${elementInfo.rotate}deg)`,
          opacity,
        }}
      >
        {elementInfo.src ? (
          <img
            src={elementInfo.src}
            draggable={false}
            alt=""
            className="w-full h-full"
            style={{ objectFit: 'cover' }}
          />
        ) : null}
      </div>
    </div>
  );
}
