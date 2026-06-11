import React from 'react';
import { createRoot } from 'react-dom/client';
import { OfflineApp } from './OfflineApp';
import type { OfflineClassroom, OfflinePlayerGlobals } from './types';

function readInlineCourseData(): OfflineClassroom {
  const globalData = (window as typeof window & OfflinePlayerGlobals).OPENMAIC_COURSE_DATA;
  if (globalData) return globalData;

  const script = document.getElementById('openmaic-course-data');
  if (!script?.textContent) {
    throw new Error('Missing inline OpenMAIC course data');
  }
  return JSON.parse(script.textContent) as OfflineClassroom;
}

const mount = document.getElementById('openmaic-offline-root');
if (!mount) {
  throw new Error('Missing #openmaic-offline-root');
}

createRoot(mount).render(
  <React.StrictMode>
    <OfflineApp classroom={readInlineCourseData()} />
  </React.StrictMode>,
);
