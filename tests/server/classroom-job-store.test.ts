import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateClassroomResult } from '@/lib/server/classroom-generation';

const mocks = vi.hoisted(() => ({
  ensureJobsDir: vi.fn(),
  readFile: vi.fn(),
  writeJsonFileAtomic: vi.fn(),
}));

vi.mock('fs', () => ({
  promises: {
    readFile: mocks.readFile,
  },
}));

vi.mock('@/lib/server/classroom-storage', () => ({
  CLASSROOM_JOBS_DIR: '/tmp/openmaic-classroom-jobs',
  ensureClassroomJobsDir: mocks.ensureJobsDir,
  writeJsonFileAtomic: mocks.writeJsonFileAtomic,
}));

import {
  createClassroomGenerationJob,
  markClassroomGenerationJobSucceeded,
} from '@/lib/server/classroom-job-store';

const generatedClassroom = {
  id: 'classroom-1',
  url: 'http://localhost:3000/classroom/classroom-1',
  stage: { id: 'classroom-1' },
  scenes: [],
  scenesCount: 2,
  createdAt: '2026-08-30T00:00:00.000Z',
} as unknown as GenerateClassroomResult;

describe('classroom job delivery mode persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureJobsDir.mockResolvedValue(undefined);
    mocks.writeJsonFileAtomic.mockResolvedValue(undefined);
  });

  it('records the requested delivery mode in the input summary', async () => {
    const job = await createClassroomGenerationJob('job-online', {
      requirement: 'Online classroom',
      deliveryMode: 'online',
    });

    expect(job.inputSummary.deliveryMode).toBe('online');
    expect(mocks.writeJsonFileAtomic).toHaveBeenCalledWith(
      '/tmp/openmaic-classroom-jobs/job-online.json',
      expect.objectContaining({
        inputSummary: expect.objectContaining({ deliveryMode: 'online' }),
      }),
    );
  });

  it('records online delivery in the final result when no artifact is published', async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        id: 'job-online',
        status: 'running',
        step: 'persisting',
        progress: 97,
        message: 'Persisting classroom',
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: new Date().toISOString(),
        inputSummary: {
          requirementPreview: 'Online classroom',
          hasPdf: false,
          pdfTextLength: 0,
          pdfImageCount: 0,
          deliveryMode: 'online',
        },
        scenesGenerated: 2,
      }),
    );

    const job = await markClassroomGenerationJobSucceeded(
      'job-online',
      generatedClassroom,
      'online',
    );

    expect(job.result).toMatchObject({
      classroomId: 'classroom-1',
      deliveryMode: 'online',
      localClassroomAvailable: true,
    });
  });

  it('records offline-oss delivery in the final result when an artifact is published', async () => {
    mocks.readFile.mockResolvedValue(
      JSON.stringify({
        id: 'job-offline',
        status: 'running',
        step: 'uploading',
        progress: 99,
        message: 'Uploading classroom',
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: new Date().toISOString(),
        inputSummary: {
          requirementPreview: 'Offline classroom',
          hasPdf: false,
          pdfTextLength: 0,
          pdfImageCount: 0,
          deliveryMode: 'offline-oss',
        },
        scenesGenerated: 2,
      }),
    );

    const job = await markClassroomGenerationJobSucceeded(
      'job-offline',
      generatedClassroom,
      'offline-oss',
      {
        zipUrl: 'https://example.com/classroom.zip',
        artifactKey: 'classroom.zip',
        storage: 'oss',
        localClassroomAvailable: false,
      },
    );

    expect(job.result).toMatchObject({
      classroomId: 'classroom-1',
      deliveryMode: 'offline-oss',
      zipUrl: 'https://example.com/classroom.zip',
      localClassroomAvailable: false,
    });
  });
});
