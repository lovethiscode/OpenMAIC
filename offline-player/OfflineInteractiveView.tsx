import React from 'react';
import type { OfflineInteractiveContent } from './types';

interface OfflineInteractiveViewProps {
  readonly content: OfflineInteractiveContent;
  readonly title?: string;
}

export function OfflineInteractiveView({ content, title }: OfflineInteractiveViewProps) {
  if (!content.offlineSrc) {
    return (
      <div className="omaic-unsupported-scene">
        <strong>{title || 'Interactive scene'}</strong>
        <span>This interactive scene was not packaged for offline playback.</span>
      </div>
    );
  }

  return (
    <iframe
      className="omaic-interactive-frame"
      src={content.offlineSrc}
      sandbox="allow-scripts allow-forms allow-modals allow-downloads"
      title={title || 'Interactive scene'}
    />
  );
}
