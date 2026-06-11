import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/lib/logger';
import type { PersistedClassroomData } from '@/lib/server/classroom-storage';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';
import { exportOfflineClassroomPackage } from '@/lib/server/offline-classroom-export';
import {
  shouldDeleteLocalAfterOssUpload,
  shouldUploadCourseZipToOss,
  uploadCoursePackageToOss,
} from '@/lib/server/course-oss-storage';

const log = createLogger('ClassroomPublisher');

export interface PublishedClassroomArtifact {
  zipUrl?: string;
  artifactKey?: string;
  storage?: 'oss';
  zipPath?: string;
  localClassroomAvailable?: boolean;
}

async function cleanupLocalClassroomArtifacts(options: {
  classroomId: string;
  outputDir: string;
  zipPath: string;
}): Promise<void> {
  await fs.rm(path.join(CLASSROOMS_DIR, `${options.classroomId}.json`), {
    force: true,
  });
  await fs.rm(path.join(CLASSROOMS_DIR, options.classroomId), {
    recursive: true,
    force: true,
  });
  await fs.rm(options.outputDir, {
    recursive: true,
    force: true,
  });
  await fs.rm(options.zipPath, {
    force: true,
  });
}

export async function publishClassroomIfConfigured(
  classroom: PersistedClassroomData,
): Promise<PublishedClassroomArtifact | undefined> {
  if (!shouldUploadCourseZipToOss()) {
    log.info('OSS upload disabled; keeping offline classroom package local only');
    return undefined;
  }

  const exported = await exportOfflineClassroomPackage(classroom);
  const uploaded = await uploadCoursePackageToOss({
    packagePath: exported.zipPath,
    courseId: classroom.id,
    version: 1,
  });

  const deleteLocalAfterUpload = shouldDeleteLocalAfterOssUpload();
  if (deleteLocalAfterUpload) {
    await cleanupLocalClassroomArtifacts({
      classroomId: classroom.id,
      outputDir: exported.outputDir,
      zipPath: exported.zipPath,
    });
    log.info(`Cleaned local classroom artifacts after OSS upload: ${classroom.id}`);
  }

  return {
    zipUrl: uploaded.zipUrl,
    artifactKey: uploaded.objectKey,
    storage: uploaded.storage,
    zipPath: exported.zipPath,
    localClassroomAvailable: !deleteLocalAfterUpload,
  };
}
