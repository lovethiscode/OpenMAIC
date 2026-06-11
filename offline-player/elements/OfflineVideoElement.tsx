import { useEffect, useRef } from 'react';
import { useCanvasStore } from '@/lib/store/canvas';
import type { PPTVideoElement } from '@/lib/types/slides';

export function OfflineVideoElement({ elementInfo }: { readonly elementInfo: PPTVideoElement }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playingVideoElementId = useCanvasStore.use.playingVideoElementId();

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const mediaSettings = (
      window as typeof window & {
        OPENMAIC_OFFLINE_MEDIA_SETTINGS?: { muted: boolean; playbackRate: number };
      }
    ).OPENMAIC_OFFLINE_MEDIA_SETTINGS;
    if (mediaSettings) {
      video.playbackRate = mediaSettings.playbackRate;
      video.muted = mediaSettings.muted;
    }
    if (playingVideoElementId === elementInfo.id) {
      video.play().catch((err) => {
        console.warn('[OpenMAIC Offline] video play failed', err);
      });
    } else {
      video.pause();
    }
  }, [playingVideoElementId, elementInfo.id]);

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
      <div className="w-full h-full" style={{ transform: `rotate(${elementInfo.rotate}deg)` }}>
        {elementInfo.src ? (
          <video
            ref={videoRef}
            data-offline-video-id={elementInfo.id}
            className="w-full h-full"
            style={{ objectFit: 'contain' }}
            src={elementInfo.src}
            poster={elementInfo.poster}
            preload="metadata"
            controls
          />
        ) : (
          <div className="omaic-video-placeholder">Video</div>
        )}
      </div>
    </div>
  );
}
