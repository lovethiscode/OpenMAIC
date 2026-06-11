import { createLogger } from '@/lib/logger';
import { generateClassroom, type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import {
  markClassroomGenerationJobFailed,
  markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';
import { publishClassroomIfConfigured } from '@/lib/server/classroom-publisher';

const log = createLogger('ClassroomJob');
const runningJobs = new Map<string, Promise<void>>();

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

      const result = await generateClassroom(input, {
        baseUrl,
        onProgress: async (progress) => {
          await updateClassroomGenerationJobProgress(jobId, progress);
        },
      });

      await updateClassroomGenerationJobProgress(jobId, {
        step: 'exporting',
        progress: 98,
        message: 'Exporting offline classroom package',
        scenesGenerated: result.scenesCount,
        totalScenes: result.scenesCount,
      });

      await updateClassroomGenerationJobProgress(jobId, {
        step: 'uploading',
        progress: 99,
        message: 'Uploading offline classroom package to OSS',
        scenesGenerated: result.scenesCount,
        totalScenes: result.scenesCount,
      });

      const artifact = await publishClassroomIfConfigured(result);

      await markClassroomGenerationJobSucceeded(jobId, result, artifact);
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
