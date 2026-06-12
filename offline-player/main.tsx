import React from 'react';
import { createRoot } from 'react-dom/client';
import { OfflineApp } from './OfflineApp';
import type {
  OfflineClassroom,
  OfflineManifest,
  OfflineManifestScene,
  OfflinePlayerGlobals,
  OfflineScene,
} from './types';

function readInlineCourseData(): OfflineClassroom | null {
  const globalData = (window as typeof window & OfflinePlayerGlobals).OPENMAIC_COURSE_DATA;
  if (globalData) return globalData;

  const script = document.getElementById('openmaic-course-data');
  if (!script?.textContent) {
    return null;
  }
  return JSON.parse(script.textContent) as OfflineClassroom;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-offline-src="${src}"]`);
    if (existing?.dataset.loaded === 'true') {
      resolve();
      return;
    }

    const script = existing || document.createElement('script');
    script.src = src;
    script.async = false;
    script.dataset.offlineSrc = src;
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load offline scene: ${src}`));
    if (!existing) document.head.appendChild(script);
  });
}

function createSceneLoadError(entry: OfflineManifestScene, error: unknown): OfflineScene {
  return {
    id: entry.id,
    stageId: '',
    type: 'slide',
    title: entry.title || 'Scene load error',
    order: entry.order,
    content: {
      type: 'error',
      message: error instanceof Error ? error.message : 'Failed to load this scene.',
    },
    actions: [],
  };
}

async function loadManifestCourse(manifest: OfflineManifest): Promise<OfflineClassroom> {
  const sceneStore =
    ((window as typeof window & OfflinePlayerGlobals).OPENMAIC_OFFLINE_SCENES ||= {});
  const scenes = await Promise.all(
    manifest.scenes
      .slice()
      .sort((a, b) => a.order - b.order)
      .map(async (entry) => {
        try {
          await loadScript(entry.src);
          return sceneStore[entry.id] || createSceneLoadError(entry, 'Scene data was not registered.');
        } catch (error) {
          return createSceneLoadError(entry, error);
        }
      }),
  );

  return {
    id: manifest.id,
    name: manifest.name,
    title: manifest.title,
    description: manifest.description,
    stage: manifest.stage,
    scenes,
  };
}

async function loadCourseData(): Promise<OfflineClassroom> {
  const globals = window as typeof window & OfflinePlayerGlobals;
  if (globals.OPENMAIC_OFFLINE_MANIFEST) {
    return loadManifestCourse(globals.OPENMAIC_OFFLINE_MANIFEST);
  }

  const inlineCourse = readInlineCourseData();
  if (inlineCourse) return inlineCourse;

  throw new Error('Missing offline course manifest.');
}

function OfflineLoading() {
  return <div className="omaic-empty">Loading offline classroom...</div>;
}

function OfflineFatalError({ error }: { readonly error: unknown }) {
  return (
    <div className="omaic-empty">
      <strong>Offline classroom failed to load.</strong>
      <span>{error instanceof Error ? error.message : 'Unknown error'}</span>
    </div>
  );
}

const mount = document.getElementById('openmaic-offline-root');
if (!mount) {
  throw new Error('Missing #openmaic-offline-root');
}

const root = createRoot(mount);
root.render(
  <React.StrictMode>
    <OfflineLoading />
  </React.StrictMode>,
);

loadCourseData()
  .then((classroom) => {
    root.render(
      <React.StrictMode>
        <OfflineApp classroom={classroom} />
      </React.StrictMode>,
    );
  })
  .catch((error) => {
    root.render(
      <React.StrictMode>
        <OfflineFatalError error={error} />
      </React.StrictMode>,
    );
  });
