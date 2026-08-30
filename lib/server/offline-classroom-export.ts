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
const REMOTE_URL_RE = /https?:\/\/[^\s"'<>]+/g;
const OFFLINE_SAFE_REMOTE_LITERALS = new Set([
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/2000/xmlns/',
  'http://www.w3.org/2001/XMLSchema',
  'http://www.w3.org/2001/XMLSchema-instance',
  'http://www.w3.org/XML/1998/namespace',
]);
const CSS_URL_RE = /url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?/gi;
const KATEX_CDN_RE = /^https?:\/\/cdn\.jsdelivr\.net\/npm\/katex@[^/]+\/dist\/(.+)$/i;
const INTERACTIVE_ACTIVITY_BRIDGE = `<script>
window.addEventListener('pointerdown', function () {
  window.parent.postMessage({ type: 'openmaic-interactive-activity' }, '*');
}, { passive: true });
</script>`;

export interface OfflineExportResult {
  outputDir: string;
  zipPath: string;
}

interface OfflineManifestScene {
  id: string;
  title: string;
  type: string;
  order: number;
  src: string;
  jsonSrc: string;
}

interface OfflineManifest {
  id: string;
  title: string;
  stage: PersistedClassroomData['stage'];
  scenes: OfflineManifestScene[];
  createdAt: string;
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

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
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

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function relativeUrl(fromDir: string, target: string): string {
  return path.posix.relative(toPosix(fromDir), toPosix(target));
}

function isRemoteUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function collectBlockingRemoteUrls(html: string): string[] {
  return Array.from(new Set(html.match(REMOTE_URL_RE) || [])).filter(
    (url) => !OFFLINE_SAFE_REMOTE_LITERALS.has(url),
  );
}

function warnBlockingRemoteUrls(sceneId: string, remoteUrls: string[]): void {
  if (remoteUrls.length === 0) return;
  log.warn(
    `Interactive scene contains remote URL text after packaging (${sceneId}); export will continue:\n${remoteUrls.join(
      '\n',
    )}`,
  );
}

function isPassthroughUrl(value: string): boolean {
  return /^(data:|blob:|#|javascript:|mailto:|tel:)/i.test(value);
}

function jsAssignment(target: string, value: unknown): string {
  return `${target} = ${safeJsonForScript(value)};\n`;
}

function rewriteCssUrls(css: string, rewriteUrl: (value: string) => Promise<string>): Promise<string> {
  return replaceAsync(css, CSS_URL_RE, async (match) => {
    const value = match[2];
    if (!value || isPassthroughUrl(value)) return match[0];
    return `url('${await rewriteUrl(value)}')`;
  }).then((rewritten) =>
    replaceAsync(rewritten, CSS_IMPORT_RE, async (match) => {
      const value = match[2];
      if (!value || isPassthroughUrl(value)) return match[0];
      return `@import '${await rewriteUrl(value)}'`;
    }),
  );
}

async function replaceAsync(
  source: string,
  regex: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
  const matches = Array.from(source.matchAll(regex));
  const replacements = await Promise.all(matches.map((match) => replacer(match)));
  let cursor = 0;
  let output = '';
  matches.forEach((match, index) => {
    output += source.slice(cursor, match.index);
    output += replacements[index];
    cursor = (match.index || 0) + match[0].length;
  });
  return output + source.slice(cursor);
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

async function copyInteractiveVendorAssets(classroom: PersistedClassroomData, outputDir: string) {
  const needsKatex = classroom.scenes.some((scene) => {
    const content = scene.content as { type?: string; html?: string };
    return (
      content.type === 'interactive' &&
      typeof content.html === 'string' &&
      Array.from(content.html.matchAll(REMOTE_URL_RE)).some((match) => KATEX_CDN_RE.test(match[0]))
    );
  });
  if (!needsKatex) return;

  const katexSource = path.join(process.cwd(), 'node_modules', 'katex', 'dist');
  const katexTarget = path.join(outputDir, 'assets', 'vendor', 'katex');
  await fs.cp(katexSource, katexTarget, { recursive: true, force: true });
}

class InteractiveAssetPackager {
  private readonly downloaded = new Map<string, string>();
  private readonly remoteDir: string;

  constructor(
    private readonly outputDir: string,
    private readonly classroomId: string,
    private readonly sceneDir: string,
  ) {
    this.remoteDir = path.join(outputDir, 'assets', 'interactive', '_vendor', 'remote');
  }

  async rewriteUrl(value: string): Promise<string> {
    if (!value || isPassthroughUrl(value)) return value;

    const katexMatch = value.match(KATEX_CDN_RE);
    if (katexMatch) {
      return relativeUrl(this.sceneDir, path.join(this.outputDir, 'assets', 'vendor', 'katex', katexMatch[1]));
    }

    const mediaPath = mediaRelativePath(value, this.classroomId);
    if (mediaPath) {
      return relativeUrl(this.sceneDir, path.join(this.outputDir, mediaPath));
    }

    if (value.startsWith('assets/')) {
      return relativeUrl(this.sceneDir, path.join(this.outputDir, value));
    }

    if (isRemoteUrl(value)) {
      return relativeUrl(this.sceneDir, await this.downloadRemote(value));
    }

    return value;
  }

  async rewriteCss(css: string): Promise<string> {
    return rewriteCssUrls(css, (url) => this.rewriteUrl(url));
  }

  private async downloadRemote(url: string): Promise<string> {
    const cached = this.downloaded.get(url);
    if (cached) return cached;

    const parsed = new URL(url);
    const digest = Buffer.from(url).toString('base64url').slice(0, 16);
    const name = path.basename(parsed.pathname) || 'asset';
    const targetDir = path.join(this.remoteDir, digest);
    const target = path.join(targetDir, name);
    await fs.mkdir(targetDir, { recursive: true });

    log.info(`Downloading interactive dependency: ${url}`);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'OpenMAIC offline exporter' },
    });
    if (!response.ok) {
      throw new Error(`Failed to download interactive dependency ${url}: ${response.status}`);
    }

    this.downloaded.set(url, target);
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/css') || target.endsWith('.css')) {
      const css = await response.text();
      const rewritten = await rewriteCssUrls(css, async (assetUrl) => {
        if (isPassthroughUrl(assetUrl)) return assetUrl;
        const dependency = new URL(assetUrl, url).toString();
        return relativeUrl(targetDir, await this.downloadRemote(dependency));
      });
      await fs.writeFile(target, rewritten, 'utf-8');
    } else {
      await fs.writeFile(target, Buffer.from(await response.arrayBuffer()));
    }

    return target;
  }
}

async function rewriteInteractiveHtml(
  sourceHtml: string,
  packager: InteractiveAssetPackager,
): Promise<string> {
  let output = sourceHtml;
  const urlAttributes = ['src', 'href', 'poster'];
  for (const attr of urlAttributes) {
    output = await replaceAsync(
      output,
      new RegExp(`(\\s${attr}\\s*=\\s*)(["'])(.*?)\\2`, 'gi'),
      async (match) => `${match[1]}${match[2]}${await packager.rewriteUrl(match[3])}${match[2]}`,
    );
  }

  output = await replaceAsync(output, /(\ssrcset\s*=\s*)(["'])(.*?)\2/gi, async (match) => {
    const candidates = await Promise.all(
      match[3]
        .split(',')
        .map((candidate) => candidate.trim())
        .filter(Boolean)
        .map(async (candidate) => {
          const parts = candidate.split(/\s+/);
          return [await packager.rewriteUrl(parts[0]), ...parts.slice(1)].join(' ');
        }),
    );
    return `${match[1]}${match[2]}${candidates.join(', ')}${match[2]}`;
  });

  output = await replaceAsync(output, /(\sstyle\s*=\s*)(["'])(.*?)\2/gi, async (match) => {
    return `${match[1]}${match[2]}${await packager.rewriteCss(match[3])}${match[2]}`;
  });

  output = await replaceAsync(output, /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, async (match) => {
    return `${match[1]}${await packager.rewriteCss(match[2])}${match[3]}`;
  });

  const bodyEnd = output.toLowerCase().lastIndexOf('</body>');
  if (bodyEnd >= 0) {
    return `${output.slice(0, bodyEnd)}${INTERACTIVE_ACTIVITY_BRIDGE}${output.slice(bodyEnd)}`;
  }
  return `${output}${INTERACTIVE_ACTIVITY_BRIDGE}`;
}

async function packageInteractiveScene(
  scene: PersistedClassroomData['scenes'][number],
  outputDir: string,
  classroomId: string,
): Promise<PersistedClassroomData['scenes'][number]> {
  if (scene.content.type !== 'interactive') return scene;

  const sourceHtml = scene.content.html;
  if (typeof sourceHtml !== 'string' || !sourceHtml.trim()) {
    throw new Error(`Interactive scene has no embedded HTML: ${scene.id}`);
  }

  const sceneDir = path.join(outputDir, 'assets', 'interactive', scene.id);
  await fs.mkdir(sceneDir, { recursive: true });
  const packager = new InteractiveAssetPackager(outputDir, classroomId, sceneDir);
  const html = await rewriteInteractiveHtml(sourceHtml, packager);
  const remoteUrls = collectBlockingRemoteUrls(html);
  warnBlockingRemoteUrls(scene.id, remoteUrls);

  await fs.writeFile(path.join(sceneDir, 'index.html'), html, 'utf-8');
  return {
    ...scene,
    content: {
      ...scene.content,
      url: '',
      html: undefined,
      offlineSrc: `assets/interactive/${scene.id}/index.html`,
    },
  } as PersistedClassroomData['scenes'][number];
}

async function renderIndex(classroom: PersistedClassroomData, outputDir: string): Promise<void> {
  const templatePath = path.join(process.cwd(), 'offline-player', 'index.template.html');
  const template = await fs.readFile(templatePath, 'utf-8');
  const title = classroom.stage?.name || 'OpenMAIC Offline Classroom';
  const html = template.replace('{{TITLE}}', () => escapeHtml(title));
  await fs.writeFile(path.join(outputDir, 'index.html'), html, 'utf-8');
}

async function writeOfflineDataFiles(
  classroom: PersistedClassroomData,
  outputDir: string,
): Promise<OfflineManifest> {
  const scenesDir = path.join(outputDir, 'scenes');
  await fs.mkdir(scenesDir, { recursive: true });

  const manifestScenes: OfflineManifestScene[] = [];
  const sceneStoreInit = 'window.OPENMAIC_OFFLINE_SCENES = window.OPENMAIC_OFFLINE_SCENES || {};\n';
  for (const scene of classroom.scenes.slice().sort((a, b) => a.order - b.order)) {
    const baseName = `${scene.id}`;
    const jsonSrc = `scenes/${baseName}.json`;
    const jsSrc = `scenes/${baseName}.js`;
    await fs.writeFile(path.join(outputDir, jsonSrc), JSON.stringify(scene), 'utf-8');
    await fs.writeFile(
      path.join(outputDir, jsSrc),
      `${sceneStoreInit}${jsAssignment(
        `window.OPENMAIC_OFFLINE_SCENES[${JSON.stringify(scene.id)}]`,
        scene,
      )}`,
      'utf-8',
    );
    manifestScenes.push({
      id: scene.id,
      title: scene.title,
      type: scene.type,
      order: scene.order,
      src: jsSrc,
      jsonSrc,
    });
  }

  const manifest: OfflineManifest = {
    id: classroom.id,
    title: classroom.stage?.name || 'OpenMAIC Offline Classroom',
    stage: classroom.stage,
    scenes: manifestScenes,
    createdAt: classroom.createdAt,
  };
  await fs.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  await fs.writeFile(
    path.join(outputDir, 'manifest.js'),
    jsAssignment('window.OPENMAIC_OFFLINE_MANIFEST', manifest),
    'utf-8',
  );
  return manifest;
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
  if (html.includes('openmaic-course-data') || html.includes('{{COURSE_JSON}}')) {
    throw new Error('index.html must not contain inline course data');
  }

  const manifest = JSON.parse(
    await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf-8'),
  ) as OfflineManifest;
  if (manifest.id !== classroom.id) {
    throw new Error('manifest.json does not match the exported classroom');
  }
  if (manifest.scenes.length !== classroom.scenes.length) {
    throw new Error('manifest.json scene count does not match the exported classroom');
  }

  for (const sceneEntry of manifest.scenes) {
    const scenePath = path.join(outputDir, sceneEntry.jsonSrc);
    const scene = JSON.parse(await fs.readFile(scenePath, 'utf-8')) as PersistedClassroomData['scenes'][number];
    if (scene.id !== sceneEntry.id) {
      throw new Error(`Scene JSON id mismatch: ${sceneEntry.id}`);
    }
    if (scene.content.type === 'interactive') {
      const content = scene.content as { html?: string; offlineSrc?: string };
      if (typeof content.html === 'string') {
        throw new Error(`Interactive scene still contains embedded HTML: ${scene.id}`);
      }
      if (!content.offlineSrc) {
        throw new Error(`Interactive scene is missing offlineSrc: ${scene.id}`);
      }
      const interactivePath = path.join(outputDir, content.offlineSrc);
      const interactiveHtml = await fs.readFile(interactivePath, 'utf-8');
      const remoteUrls = collectBlockingRemoteUrls(interactiveHtml);
      warnBlockingRemoteUrls(scene.id, remoteUrls);
    }
  }

  const forbidden = ['http://localhost', '/api/classroom', '/api/classroom-media', 'IndexedDB'];
  const exportedText = await collectExportedText(outputDir);
  const found = forbidden.filter((item) => exportedText.includes(item));
  if (found.length > 0) {
    throw new Error(`Forbidden online references remain in offline export: ${found.join(', ')}`);
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

async function collectExportedText(outputDir: string): Promise<string> {
  const chunks: string[] = [];
  const visit = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (
        /\.(html|json|js|css)$/i.test(entry.name) &&
        entry.name !== 'offline-player.js' &&
        entry.name !== 'offline-player.css'
      ) {
        chunks.push(await fs.readFile(fullPath, 'utf-8'));
      }
    }
  };
  await visit(outputDir);
  return chunks.join('\n');
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
  await copyInteractiveVendorAssets(rewritten, outputDir);
  const packagedScenes = await Promise.all(
    rewritten.scenes.map((scene) => packageInteractiveScene(scene, outputDir, classroomId)),
  );
  const packagedClassroom = { ...rewritten, scenes: packagedScenes };
  await writeOfflineDataFiles(packagedClassroom, outputDir);
  await renderIndex(packagedClassroom, outputDir);
  await copyPlayerFiles(outputDir);
  await validateExport(packagedClassroom, outputDir);

  const zipPath = await zipExportDirectory(outputDir, classroomId);
  return { outputDir, zipPath };
}
