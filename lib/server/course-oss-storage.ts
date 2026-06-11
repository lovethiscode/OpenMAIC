import { createHmac } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/lib/logger';

const log = createLogger('CourseOSS');

export class CourseStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CourseStorageError';
  }
}

export interface CourseStorageUploadResult {
  zipUrl: string;
  objectKey: string;
  storage: 'oss';
}

interface OssSettings {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  endpoint: string;
  region: string;
  prefix: string;
  publicBaseUrl: string;
  retryCount: number;
  retryDelaySeconds: number;
}

function readSettings(): OssSettings {
  return {
    accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID || '',
    accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET || '',
    bucket: process.env.ALIYUN_OSS_BUCKET || '',
    endpoint: normalizeEndpoint(process.env.ALIYUN_OSS_ENDPOINT || ''),
    region: process.env.ALIYUN_OSS_REGION || '',
    prefix: process.env.AI_COURSE_OSS_PREFIX || 'ai_courses',
    publicBaseUrl: process.env.AI_COURSE_OSS_PUBLIC_BASE_URL || '',
    retryCount: Math.max(0, Number(process.env.AI_COURSE_OSS_UPLOAD_RETRY_COUNT || 3)),
    retryDelaySeconds: Math.max(
      0,
      Number(process.env.AI_COURSE_OSS_UPLOAD_RETRY_DELAY_SECONDS || 1),
    ),
  };
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function validateSettings(settings: OssSettings): void {
  const missing = Object.entries({
    ALIYUN_OSS_ACCESS_KEY_ID: settings.accessKeyId,
    ALIYUN_OSS_ACCESS_KEY_SECRET: settings.accessKeySecret,
    ALIYUN_OSS_BUCKET: settings.bucket,
    ALIYUN_OSS_ENDPOINT: settings.endpoint,
    ALIYUN_OSS_REGION: settings.region,
  })
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new CourseStorageError(`OSS configuration missing: ${missing.join(', ')}`);
  }
}

function buildObjectKey(prefix: string, courseId: string, version: number): string {
  const safePrefix = (prefix || 'ai_courses').trim().replace(/^\/+|\/+$/g, '');
  const safeCourseId = courseId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeVersion = Math.max(1, Math.floor(version || 1));
  return `${safePrefix}/${safeCourseId}/course_${safeCourseId}_v${safeVersion}.zip`;
}

function buildPublicUrl(settings: OssSettings, objectKey: string): string {
  if (settings.publicBaseUrl) {
    return `${settings.publicBaseUrl.replace(/\/+$/, '')}/${objectKey}`;
  }
  if (settings.endpoint.includes('-internal.')) {
    throw new CourseStorageError(
      'AI_COURSE_OSS_PUBLIC_BASE_URL is required when ALIYUN_OSS_ENDPOINT is an internal endpoint',
    );
  }
  return `https://${settings.bucket}.${settings.endpoint}/${objectKey}`;
}

function signOssRequest(options: {
  method: 'PUT' | 'HEAD';
  bucket: string;
  objectKey: string;
  accessKeyId: string;
  accessKeySecret: string;
  contentType?: string;
  date: string;
}): string {
  const contentType = options.contentType || '';
  const canonicalizedResource = `/${options.bucket}/${options.objectKey}`;
  const stringToSign = [
    options.method,
    '',
    contentType,
    options.date,
    canonicalizedResource,
  ].join('\n');
  const signature = createHmac('sha1', options.accessKeySecret)
    .update(stringToSign)
    .digest('base64');
  return `OSS ${options.accessKeyId}:${signature}`;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function putObject(settings: OssSettings, objectKey: string, body: Buffer): Promise<void> {
  const date = new Date().toUTCString();
  const contentType = 'application/zip';
  const authorization = signOssRequest({
    method: 'PUT',
    bucket: settings.bucket,
    objectKey,
    accessKeyId: settings.accessKeyId,
    accessKeySecret: settings.accessKeySecret,
    contentType,
    date,
  });

  const response = await fetch(`https://${settings.bucket}.${settings.endpoint}/${objectKey}`, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      Date: date,
    },
    body: new Uint8Array(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new CourseStorageError(
      `OSS upload failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`,
    );
  }
}

async function headObject(settings: OssSettings, objectKey: string): Promise<void> {
  const date = new Date().toUTCString();
  const authorization = signOssRequest({
    method: 'HEAD',
    bucket: settings.bucket,
    objectKey,
    accessKeyId: settings.accessKeyId,
    accessKeySecret: settings.accessKeySecret,
    date,
  });

  const response = await fetch(`https://${settings.bucket}.${settings.endpoint}/${objectKey}`, {
    method: 'HEAD',
    headers: {
      Authorization: authorization,
      Date: date,
    },
  });

  if (!response.ok) {
    throw new CourseStorageError(`OSS HEAD verification failed: HTTP ${response.status}`);
  }
}

export function shouldUploadCourseZipToOss(): boolean {
  return process.env.OPENMAIC_UPLOAD_COURSE_ZIP_TO_OSS === 'true';
}

export function shouldDeleteLocalAfterOssUpload(): boolean {
  return process.env.OPENMAIC_DELETE_LOCAL_AFTER_OSS_UPLOAD === 'true';
}

export async function uploadCoursePackageToOss(options: {
  packagePath: string;
  courseId: string;
  version?: number;
}): Promise<CourseStorageUploadResult> {
  const settings = readSettings();
  validateSettings(settings);

  const packagePath = options.packagePath;
  const stat = await fs.stat(packagePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new CourseStorageError(`Course package does not exist: ${packagePath}`);
  }

  const objectKey = buildObjectKey(settings.prefix, options.courseId, options.version ?? 1);
  const body = await fs.readFile(packagePath);
  const attempts = settings.retryCount + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await putObject(settings, objectKey, body);
      await headObject(settings, objectKey);
      const zipUrl = buildPublicUrl(settings, objectKey);
      log.info(
        `Course package uploaded: courseId=${options.courseId}, key=${objectKey}, file=${path.basename(packagePath)}`,
      );
      return { zipUrl, objectKey, storage: 'oss' };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      log.warn(
        `Course package OSS upload failed, retrying: courseId=${options.courseId}, attempt=${attempt}/${attempts}`,
        error,
      );
      await sleep(settings.retryDelaySeconds * 1000);
    }
  }

  throw new CourseStorageError(
    `OSS upload failed after ${attempts} attempt(s): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    lastError instanceof Error ? { cause: lastError } : undefined,
  );
}
