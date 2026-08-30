import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedClassroomData } from '@/lib/server/classroom-storage';

const mocks = vi.hoisted(() => ({
  exportOffline: vi.fn(),
  shouldDeleteLocal: vi.fn(),
  shouldUpload: vi.fn(),
  uploadToOss: vi.fn(),
}));

vi.mock('@/lib/server/offline-classroom-export', () => ({
  exportOfflineClassroomPackage: mocks.exportOffline,
}));

vi.mock('@/lib/server/course-oss-storage', () => ({
  shouldDeleteLocalAfterOssUpload: mocks.shouldDeleteLocal,
  shouldUploadCourseZipToOss: mocks.shouldUpload,
  uploadCoursePackageToOss: mocks.uploadToOss,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { publishClassroomIfConfigured } from '@/lib/server/classroom-publisher';

const classroom = {
  id: 'classroom-1',
  stage: { id: 'classroom-1' },
  scenes: [],
  createdAt: '2026-08-30T00:00:00.000Z',
} as unknown as PersistedClassroomData;

describe('classroom publisher progress boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shouldUpload.mockReturnValue(true);
    mocks.shouldDeleteLocal.mockReturnValue(false);
  });

  it('reports upload start after export and before the OSS request', async () => {
    const events: string[] = [];
    mocks.exportOffline.mockImplementation(async () => {
      events.push('export');
      return {
        outputDir: '/tmp/classroom-1',
        zipPath: '/tmp/classroom-1.zip',
      };
    });
    mocks.uploadToOss.mockImplementation(async () => {
      events.push('upload');
      return {
        zipUrl: 'https://example.com/classroom-1.zip',
        objectKey: 'classroom-1.zip',
        storage: 'oss',
      };
    });

    await publishClassroomIfConfigured(classroom, {
      onUploadStarted: () => {
        events.push('uploading-progress');
      },
    });

    expect(events).toEqual(['export', 'uploading-progress', 'upload']);
  });
});
