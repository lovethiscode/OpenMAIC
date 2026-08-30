import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  createJob: vi.fn(),
  runJob: vi.fn(),
  shouldUpload: vi.fn(),
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: mocks.after };
});

vi.mock('@/lib/server/classroom-job-runner', () => ({
  runClassroomGenerationJob: mocks.runJob,
}));

vi.mock('@/lib/server/classroom-job-store', () => ({
  createClassroomGenerationJob: mocks.createJob,
}));

vi.mock('@/lib/server/classroom-storage', () => ({
  buildRequestOrigin: () => 'http://localhost:3000',
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

async function postGenerateClassroom(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/generate-classroom/route');
  const request = new Request('http://localhost:3000/api/generate-classroom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/generate-classroom deliveryMode', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.shouldUpload.mockReturnValue(true);
    mocks.createJob.mockResolvedValue({
      status: 'queued',
      step: 'queued',
      message: 'Classroom generation job queued',
    });
  });

  it('forwards online mode to the background job', async () => {
    const callbacks: Array<() => unknown> = [];
    mocks.after.mockImplementation((callback) => callbacks.push(callback));

    const response = await postGenerateClassroom({
      requirement: 'Online classroom',
      deliveryMode: 'online',
    });
    expect(response.status).toBe(202);
    expect(callbacks).toHaveLength(1);
    expect(mocks.createJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ deliveryMode: 'online' }),
    );

    callbacks[0]();
    expect(mocks.runJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        requirement: 'Online classroom',
        deliveryMode: 'online',
      }),
      'http://localhost:3000',
    );
  });

  it('accepts offline-oss when the server enables OSS publishing', async () => {
    const callbacks: Array<() => unknown> = [];
    mocks.after.mockImplementation((callback) => callbacks.push(callback));

    const response = await postGenerateClassroom({
      requirement: 'Offline classroom',
      deliveryMode: 'offline-oss',
    });

    expect(response.status).toBe(202);
    expect(mocks.createJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ deliveryMode: 'offline-oss' }),
    );
    callbacks[0]();
    expect(mocks.runJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ deliveryMode: 'offline-oss' }),
      'http://localhost:3000',
    );
  });

  it('preserves the legacy request shape when deliveryMode is omitted', async () => {
    mocks.after.mockImplementation(() => undefined);

    const response = await postGenerateClassroom({ requirement: 'Legacy classroom' });

    expect(response.status).toBe(202);
    expect(mocks.createJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.objectContaining({ deliveryMode: expect.anything() }),
    );
  });

  it('rejects an invalid delivery mode', async () => {
    const response = await postGenerateClassroom({
      requirement: 'Invalid classroom',
      deliveryMode: 'zip-only',
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it('rejects offline-oss when the server has disabled OSS publishing', async () => {
    mocks.shouldUpload.mockReturnValue(false);

    const response = await postGenerateClassroom({
      requirement: 'Offline classroom',
      deliveryMode: 'offline-oss',
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
    expect(mocks.createJob).not.toHaveBeenCalled();
  });
});
