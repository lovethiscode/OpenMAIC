import type { Action } from '@/lib/types/action';
import type { Scene, SceneContent } from '@/lib/types/stage';

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
  content: SceneContent;
  actions?: Action[];
}

export interface OfflinePlayerGlobals {
  OPENMAIC_COURSE_DATA?: OfflineClassroom;
}
