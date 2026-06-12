import type { Action } from '@/lib/types/action';
import type { InteractiveContent, Scene, SceneContent } from '@/lib/types/stage';

export interface OfflineManifestScene {
  id: string;
  title?: string;
  type: string;
  order: number;
  src: string;
  jsonSrc?: string;
}

export interface OfflineManifest {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  stage?: {
    name?: string;
    title?: string;
  };
  scenes: OfflineManifestScene[];
}

export interface OfflineInteractiveContent extends InteractiveContent {
  offlineSrc?: string;
}

export interface OfflineErrorContent {
  type: 'error';
  message: string;
}

export type OfflineSceneContent =
  | Exclude<SceneContent, InteractiveContent>
  | OfflineInteractiveContent
  | OfflineErrorContent;

export interface OfflineClassroom {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  stage?: {
    name?: string;
    title?: string;
  };
  scenes: OfflineScene[];
}

export interface OfflineScene extends Omit<Scene, 'content' | 'actions'> {
  content: OfflineSceneContent;
  actions?: Action[];
}

export interface OfflinePlayerGlobals {
  OPENMAIC_COURSE_DATA?: OfflineClassroom;
  OPENMAIC_OFFLINE_MANIFEST?: OfflineManifest;
  OPENMAIC_OFFLINE_SCENES?: Record<string, OfflineScene>;
}
