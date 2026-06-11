import { promises as fs } from 'fs';
import type { Dirent } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { createLogger } from '@/lib/logger';
import type { PersistedClassroomData } from '@/lib/server/classroom-storage';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';

const log = createLogger('OfflineExport');

const DIST_OFFLINE_DIR = path.join(process.cwd(), 'dist-offline');
const EXPORTS_DIR = path.join(process.cwd(), 'exports');

export interface OfflineExportResult {
  outputDir: string;
  zipPath: string;
}

function mediaRelativePath(value: string, classroomId: string): string | null {
  const marker = `/api/classroom-media/${classroomId}/`;
  if (value.includes(marker)) {
    return `assets/${value.split(marker)[1]}`;
  }

  try {
    const parsed = new URL(value);
    if (parsed.pathname.includes(marker)) {
      return `assets/${parsed.pathname.split(marker)[1]}`;
    }
  } catch {
    // Plain relative path; continue below.
  }

  const localMarker = `data/classrooms/${classroomId}/`;
  if (value.startsWith(localMarker)) {
    return `assets/${value.split(localMarker)[1]}`;
  }

  return null;
}

function rewriteString(value: string, classroomId: string): string {
  const mediaPath = mediaRelativePath(value, classroomId);
  if (mediaPath) return mediaPath;

  try {
    const parsed = new URL(value);
    if (parsed.hostname === 'localhost' && parsed.pathname === `/classroom/${classroomId}`) {
      return './index.html';
    }
  } catch {
    // Plain string; keep it as-is.
  }

  return value;
}

function rewriteAssets(value: unknown, classroomId: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteAssets(item, classroomId));
  }

  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      output[key] = rewriteAssets(item, classroomId);
    }

    if (typeof input.audioUrl === 'string') {
      const rewritten = mediaRelativePath(input.audioUrl, classroomId);
      if (rewritten) output.audioSrc = rewritten;
    }

    return output;
  }

  if (typeof value === 'string') {
    return rewriteString(value, classroomId);
  }

  return value;
}

function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function copyDirContents(sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  let entries: Dirent[];
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      log.warn(`Classroom media directory does not exist: ${sourceDir}`);
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await fs.cp(source, target, { recursive: true, force: true });
    } else if (entry.isFile()) {
      await fs.copyFile(source, target);
    }
  }
}

async function renderIndex(classroom: PersistedClassroomData, outputDir: string): Promise<void> {
  const templatePath = path.join(process.cwd(), 'offline-player', 'index.template.html');
  const template = await fs.readFile(templatePath, 'utf-8');
  const title = classroom.stage?.name || 'OpenMAIC Offline Classroom';
  const html = template
    .replace('{{TITLE}}', escapeHtml(title))
    .replace('{{COURSE_JSON}}', safeJsonForHtml(classroom));
  await fs.writeFile(path.join(outputDir, 'index.html'), html, 'utf-8');
}

async function copyPlayerFiles(outputDir: string): Promise<void> {
  const files = ['offline-player.js', 'offline-player.css'];
  for (const file of files) {
    const source = path.join(DIST_OFFLINE_DIR, file);
    try {
      await fs.copyFile(source, path.join(outputDir, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `Missing offline player file: ${source}. Run "pnpm build:offline-player" before exporting.`,
        );
      }
      throw error;
    }
  }
}

function collectAssetRefs(value: unknown, refs = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectAssetRefs(item, refs);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectAssetRefs(item, refs);
  } else if (typeof value === 'string' && value.startsWith('assets/')) {
    refs.add(value);
  }
  return refs;
}

async function validateExport(classroom: PersistedClassroomData, outputDir: string): Promise<void> {
  const html = await fs.readFile(path.join(outputDir, 'index.html'), 'utf-8');
  const forbidden = ['http://localhost', '/api/classroom', '/api/classroom-media', 'IndexedDB'];
  const found = forbidden.filter((item) => html.includes(item));
  if (found.length > 0) {
    throw new Error(`Forbidden online references remain in index.html: ${found.join(', ')}`);
  }

  const missing: string[] = [];
  for (const ref of collectAssetRefs(classroom)) {
    try {
      await fs.access(path.join(outputDir, ref));
    } catch {
      missing.push(ref);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing exported assets:\n${missing.join('\n')}`);
  }
}

async function addDirectoryToZip(zip: JSZip, sourceDir: string, zipRootName: string): Promise<void> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const zipPath = `${zipRootName}/${entry.name}`;
    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, source, zipPath);
    } else if (entry.isFile()) {
      zip.file(zipPath, await fs.readFile(source));
    }
  }
}

async function zipExportDirectory(outputDir: string, classroomId: string): Promise<string> {
  const zip = new JSZip();
  const zipRootName = `${classroomId}-offline`;
  await addDirectoryToZip(zip, outputDir, zipRootName);
  const zipPath = path.join(EXPORTS_DIR, `${zipRootName}.zip`);
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  await fs.mkdir(EXPORTS_DIR, { recursive: true });
  await fs.writeFile(zipPath, buffer);
  return zipPath;
}

export async function exportOfflineClassroomPackage(
  classroom: PersistedClassroomData,
): Promise<OfflineExportResult> {
  const classroomId = classroom.id;
  const rewritten = rewriteAssets(classroom, classroomId) as PersistedClassroomData;
  const outputDir = path.join(EXPORTS_DIR, `${classroomId}-offline`);

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  await copyDirContents(path.join(CLASSROOMS_DIR, classroomId), path.join(outputDir, 'assets'));
  await renderIndex(rewritten, outputDir);
  await copyPlayerFiles(outputDir);
  await validateExport(rewritten, outputDir);

  const zipPath = await zipExportDirectory(outputDir, classroomId);
  return { outputDir, zipPath };
}
