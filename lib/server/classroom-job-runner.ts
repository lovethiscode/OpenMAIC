import { createLogger } from '@/lib/logger';
import {
  generateClassroom,
  type ClassroomDeliveryMode,
  type GenerateClassroomInput,
} from '@/lib/server/classroom-generation';
import {
  markClassroomGenerationJobFailed,
  markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';
import { publishClassroomIfConfigured } from '@/lib/server/classroom-publisher';
import { shouldUploadCourseZipToOss } from '@/lib/server/course-oss-storage';

const log = createLogger('ClassroomJob');
const runningJobs = new Map<string, Promise<void>>();

function resolveDeliveryMode(requested?: ClassroomDeliveryMode): ClassroomDeliveryMode {
  if (requested === 'online') {
    return requested;
  }

  const ossEnabled = shouldUploadCourseZipToOss();
  if (requested === 'offline-oss' && !ossEnabled) {
    throw new Error('deliveryMode "offline-oss" is not enabled on this server');
  }
  return requested ?? (ossEnabled ? 'offline-oss' : 'online');
}

export function runClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  baseUrl: string,
): Promise<void> {
  const existing = runningJobs.get(jobId);
  if (existing) {
    return existing;
  }

  const jobPromise = (async () => {
    try {
      await markClassroomGenerationJobRunning(jobId);
      const deliveryMode = resolveDeliveryMode(input.deliveryMode);

      const result = await generateClassroom(input, {
        baseUrl,
        onProgress: async (progress) => {
          await updateClassroomGenerationJobProgress(jobId, progress);
        },
      });

      let artifact;
      if (deliveryMode === 'offline-oss') {
        await updateClassroomGenerationJobProgress(jobId, {
          step: 'exporting',
          progress: 98,
          message: 'Exporting offline classroom package',
          scenesGenerated: result.scenesCount,
          totalScenes: result.scenesCount,
        });

        artifact = await publishClassroomIfConfigured(result, {
          onUploadStarted: async () => {
            await updateClassroomGenerationJobProgress(jobId, {
              step: 'uploading',
              progress: 99,
              message: 'Uploading offline classroom package to OSS',
              scenesGenerated: result.scenesCount,
              totalScenes: result.scenesCount,
            });
          },
        });
        if (!artifact) {
          throw new Error('Offline classroom publishing was enabled but produced no artifact');
        }
      }

      await markClassroomGenerationJobSucceeded(jobId, result, deliveryMode, artifact);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Classroom generation job ${jobId} failed:`, error);
      try {
        await markClassroomGenerationJobFailed(jobId, message);
      } catch (markFailedError) {
        log.error(`Failed to persist failed status for job ${jobId}:`, markFailedError);
      }
    } finally {
      runningJobs.delete(jobId);
    }
  })();

  runningJobs.set(jobId, jobPromise);
  return jobPromise;
}
