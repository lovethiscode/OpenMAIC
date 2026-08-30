import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateClassroomResult } from '@/lib/server/classroom-generation';

const mocks = vi.hoisted(() => ({
  generateClassroom: vi.fn(),
  markFailed: vi.fn(),
  markRunning: vi.fn(),
  markSucceeded: vi.fn(),
  publishClassroom: vi.fn(),
  shouldUpload: vi.fn(),
  updateProgress: vi.fn(),
}));

vi.mock('@/lib/server/classroom-generation', () => ({
  generateClassroom: mocks.generateClassroom,
}));

vi.mock('@/lib/server/classroom-job-store', () => ({
  markClassroomGenerationJobFailed: mocks.markFailed,
  markClassroomGenerationJobRunning: mocks.markRunning,
  markClassroomGenerationJobSucceeded: mocks.markSucceeded,
  updateClassroomGenerationJobProgress: mocks.updateProgress,
}));

vi.mock('@/lib/server/classroom-publisher', () => ({
  publishClassroomIfConfigured: mocks.publishClassroom,
}));

vi.mock('@/lib/server/course-oss-storage', () => ({
  shouldUploadCourseZipToOss: mocks.shouldUpload,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';

const result = {
  id: 'classroom-1',
  url: 'http://localhost:3000/classroom/classroom-1',
  stage: { id: 'classroom-1' },
  scenes: [],
  scenesCount: 2,
  createdAt: '2026-08-30T00:00:00.000Z',
} as unknown as GenerateClassroomResult;

describe('classroom job delivery mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markRunning.mockResolvedValue(undefined);
    mocks.updateProgress.mockResolvedValue(undefined);
    mocks.generateClassroom.mockResolvedValue(result);
    mocks.markSucceeded.mockResolvedValue(undefined);
    mocks.markFailed.mockResolvedValue(undefined);
    mocks.shouldUpload.mockReturnValue(true);
    mocks.publishClassroom.mockImplementation(async (...args: unknown[]) => {
      const options = args[1] as { onUploadStarted?: () => Promise<void> | void } | undefined;
      await options?.onUploadStarted?.();
      return {
        zipUrl: 'https://example.com/classroom.zip',
        artifactKey: 'classroom.zip',
        storage: 'oss',
        localClassroomAvailable: true,
      };
    });
  });

  it('keeps an online classroom without exporting or uploading', async () => {
    await runClassroomGenerationJob(
      'job-online',
      { requirement: 'Online classroom', deliveryMode: 'online' },
      'http://localhost:3000',
    );

    expect(mocks.shouldUpload).not.toHaveBeenCalled();
    expect(mocks.publishClassroom).not.toHaveBeenCalled();
    expect(mocks.updateProgress).not.toHaveBeenCalledWith(
      'job-online',
      expect.objectContaining({ step: 'exporting' }),
    );
    expect(mocks.updateProgress).not.toHaveBeenCalledWith(
      'job-online',
      expect.objectContaining({ step: 'uploading' }),
    );
    expect(mocks.markSucceeded).toHaveBeenCalledWith('job-online', result, 'online', undefined);
  });

  it('exports and uploads when offline-oss is explicitly requested', async () => {
    await runClassroomGenerationJob(
      'job-offline',
      { requirement: 'Offline classroom', deliveryMode: 'offline-oss' },
      'http://localhost:3000',
    );

    expect(mocks.publishClassroom).toHaveBeenCalledWith(
      result,
      expect.objectContaining({ onUploadStarted: expect.any(Function) }),
    );
    expect(mocks.updateProgress.mock.calls.map(([, progress]) => progress.step)).toEqual([
      'exporting',
      'uploading',
    ]);
    expect(mocks.markSucceeded).toHaveBeenCalledWith(
      'job-offline',
      result,
      'offline-oss',
      expect.objectContaining({ storage: 'oss' }),
    );
  });

  it('uses the server default when deliveryMode is omitted', async () => {
    mocks.shouldUpload.mockReturnValue(false);

    await runClassroomGenerationJob(
      'job-default',
      { requirement: 'Default classroom' },
      'http://localhost:3000',
    );

    expect(mocks.publishClassroom).not.toHaveBeenCalled();
    expect(mocks.markSucceeded).toHaveBeenCalledWith('job-default', result, 'online', undefined);
  });

  it('preserves OSS publishing for legacy requests when the server enables it', async () => {
    await runClassroomGenerationJob(
      'job-legacy-oss',
      { requirement: 'Legacy classroom' },
      'http://localhost:3000',
    );

    expect(mocks.publishClassroom).toHaveBeenCalledWith(
      result,
      expect.objectContaining({ onUploadStarted: expect.any(Function) }),
    );
    expect(mocks.markSucceeded).toHaveBeenCalledWith(
      'job-legacy-oss',
      result,
      'offline-oss',
      expect.objectContaining({ storage: 'oss' }),
    );
  });

  it('fails before generation when offline-oss is disabled on the server', async () => {
    mocks.shouldUpload.mockReturnValue(false);

    await runClassroomGenerationJob(
      'job-disabled',
      { requirement: 'Offline classroom', deliveryMode: 'offline-oss' },
      'http://localhost:3000',
    );

    expect(mocks.generateClassroom).not.toHaveBeenCalled();
    expect(mocks.publishClassroom).not.toHaveBeenCalled();
    expect(mocks.markFailed).toHaveBeenCalledWith(
      'job-disabled',
      'deliveryMode "offline-oss" is not enabled on this server',
    );
  });
});
