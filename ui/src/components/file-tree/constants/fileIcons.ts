import { Image, Video, type LucideIcon } from 'lucide-react';
import archiveIcon from '../../../assets/file-categories/archive.svg';
import audioIcon from '../../../assets/file-categories/audio.svg';
import codeIcon from '../../../assets/file-categories/code.svg';
import dataIcon from '../../../assets/file-categories/data.svg';
import documentIcon from '../../../assets/file-categories/document.svg';
import presentationIcon from '../../../assets/file-categories/presentation.svg';
import spreadsheetIcon from '../../../assets/file-categories/spreadsheet.svg';

export const ICON_SIZE_CLASS = 'w-4 h-4 flex-shrink-0';

export type FileVisualCategory =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'code'
  | 'data'
  | 'archive'
  | 'audio'
  | 'image'
  | 'video';

export type FileIconData = {
  category: FileVisualCategory;
  asset?: string;
  icon?: LucideIcon;
  color?: string;
  containerClass: string;
};

const CATEGORY_EXTENSIONS: ReadonlyArray<readonly [FileVisualCategory, ReadonlySet<string>]> = [
  ['spreadsheet', new Set([
    'xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm',
    'ods', 'fods', 'et', 'ett', 'csv', 'tsv', 'numbers',
  ])],
  ['presentation', new Set([
    'ppt', 'pptx', 'pptm', 'pot', 'potx', 'potm', 'pps', 'ppsx', 'ppsm',
    'odp', 'dps', 'key',
  ])],
  ['code', new Set([
    'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'cs',
    'java', 'kt', 'kts', 'scala', 'groovy',
    'py', 'pyw', 'pyi', 'ipynb',
    'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
    'go', 'rs', 'rb', 'erb', 'php', 'swift', 'm', 'mm',
    'lua', 'r', 'dart', 'ex', 'exs', 'erl', 'hrl', 'fs', 'fsx',
    'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less',
    'vue', 'svelte', 'astro',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'sql', 'graphql', 'gql', 'proto', 'sol', 'wasm',
  ])],
  ['data', new Set([
    'json', 'jsonc', 'json5', 'xml', 'yaml', 'yml', 'toml',
    'ini', 'cfg', 'conf', 'env', 'log', 'map', 'lock',
    'db', 'sqlite', 'sqlite3', 'parquet', 'avro', 'ndjson', 'jsonl',
  ])],
  ['archive', new Set([
    'zip', 'tar', 'tar.gz', 'tgz', 'gz', 'tar.bz2', 'tbz', 'tbz2', 'bz2',
    'tar.xz', 'txz', 'xz', 'rar', '7z', 'jar', 'war', 'iso', 'dmg',
  ])],
  ['audio', new Set([
    'mp3', 'wav', 'ogg', 'oga', 'flac', 'aac', 'm4a', 'wma', 'opus', 'aif', 'aiff',
  ])],
  ['image', new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico',
    'tif', 'tiff', 'avif', 'heic', 'heif',
  ])],
  ['video', new Set([
    'mp4', 'mov', 'avi', 'webm', 'mkv', 'flv', 'wmv', 'm4v', 'mpeg', 'mpg', '3gp',
  ])],
  ['document', new Set([
    'doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'wps', 'odt',
    'pdf', 'md', 'mdx', 'txt', 'rtf', 'tex', 'rst', 'pages', 'epub', 'mobi',
  ])],
];

const CATEGORY_BY_EXTENSION = new Map<string, FileVisualCategory>();
for (const [category, extensions] of CATEGORY_EXTENSIONS) {
  for (const extension of extensions) CATEGORY_BY_EXTENSION.set(extension, category);
}

const SPECIAL_FILENAME_CATEGORIES = new Map<string, FileVisualCategory>([
  ['dockerfile', 'code'],
  ['makefile', 'code'],
  ['cmakelists.txt', 'code'],
  ['gemfile', 'code'],
  ['rakefile', 'code'],
  ['jenkinsfile', 'code'],
  ['procfile', 'code'],
  ['readme', 'document'],
  ['license', 'document'],
]);

const COMPOUND_EXTENSIONS = ['tar.gz', 'tar.bz2', 'tar.xz'] as const;

const CATEGORY_ASSETS: Partial<Record<FileVisualCategory, string>> = {
  document: documentIcon,
  spreadsheet: spreadsheetIcon,
  presentation: presentationIcon,
  code: codeIcon,
  data: dataIcon,
  archive: archiveIcon,
  audio: audioIcon,
};

const CATEGORY_CONTAINER_CLASSES: Record<FileVisualCategory, string> = {
  document: 'bg-blue-50 text-blue-700 dark:bg-blue-950/70 dark:text-blue-300',
  spreadsheet: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300',
  presentation: 'bg-orange-50 text-orange-700 dark:bg-orange-950/70 dark:text-orange-300',
  code: 'bg-violet-50 text-violet-700 dark:bg-violet-950/70 dark:text-violet-300',
  data: 'bg-teal-50 text-teal-700 dark:bg-teal-950/70 dark:text-teal-300',
  archive: 'bg-amber-50 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300',
  audio: 'bg-pink-50 text-pink-700 dark:bg-pink-950/70 dark:text-pink-300',
  image: 'bg-violet-50 text-violet-700 dark:bg-violet-950/70 dark:text-violet-300',
  video: 'bg-rose-50 text-rose-700 dark:bg-rose-950/70 dark:text-rose-300',
};

function basenameOf(filename: string): string {
  const withoutQuery = filename.split(/[?#]/, 1)[0] || filename;
  return withoutQuery.split(/[\\/]/).pop()?.toLowerCase() || '';
}

function extensionOf(filename: string): string {
  const basename = basenameOf(filename);
  const compound = COMPOUND_EXTENSIONS.find((extension) => basename.endsWith(`.${extension}`));
  if (compound) return compound;
  const dotIndex = basename.lastIndexOf('.');
  return dotIndex >= 0 && dotIndex < basename.length - 1 ? basename.slice(dotIndex + 1) : '';
}

function categoryFromMimeType(mimeType?: string): FileVisualCategory | null {
  const mime = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  if (!mime || mime === 'application/octet-stream') return null;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (
    mime.startsWith('application/vnd.ms-excel')
    || mime.startsWith('application/vnd.openxmlformats-officedocument.spreadsheetml')
    || mime === 'application/vnd.oasis.opendocument.spreadsheet'
    || mime === 'application/vnd.apple.numbers'
    || mime === 'text/csv'
    || mime === 'text/tab-separated-values'
  ) return 'spreadsheet';
  if (
    mime.startsWith('application/vnd.ms-powerpoint')
    || mime.startsWith('application/vnd.openxmlformats-officedocument.presentationml')
    || mime === 'application/vnd.oasis.opendocument.presentation'
    || mime === 'application/vnd.apple.keynote'
  ) return 'presentation';
  if (
    mime === 'application/json'
    || mime.endsWith('+json')
    || mime === 'application/xml'
    || mime === 'text/xml'
  ) return 'data';
  if (
    mime.includes('javascript')
    || mime === 'text/css'
    || mime === 'text/html'
    || mime.startsWith('text/x-')
  ) return 'code';
  if (
    mime.includes('zip')
    || mime.includes('compressed')
    || mime.includes('archive')
    || mime === 'application/x-tar'
  ) return 'archive';
  if (
    mime === 'application/pdf'
    || mime === 'application/msword'
    || mime.startsWith('application/vnd.ms-word')
    || mime.startsWith('application/vnd.openxmlformats-officedocument.wordprocessingml')
    || mime === 'application/vnd.oasis.opendocument.text'
    || mime === 'text/markdown'
    || mime === 'text/plain'
  ) return 'document';
  return null;
}

export function getFileVisualCategory(filename: string, mimeType?: string): FileVisualCategory {
  const basename = basenameOf(filename);
  if (basename.startsWith('.env')) return 'data';

  const specialCategory = SPECIAL_FILENAME_CATEGORIES.get(basename);
  if (specialCategory) return specialCategory;

  const extensionCategory = CATEGORY_BY_EXTENSION.get(extensionOf(basename));
  if (extensionCategory) return extensionCategory;

  return categoryFromMimeType(mimeType) || 'document';
}

export function getFileIconData(filename: string, mimeType?: string): FileIconData {
  const category = getFileVisualCategory(filename, mimeType);
  if (category === 'image') {
    return {
      category,
      icon: Image,
      color: 'text-purple-500 dark:text-purple-400',
      containerClass: CATEGORY_CONTAINER_CLASSES[category],
    };
  }
  if (category === 'video') {
    return {
      category,
      icon: Video,
      color: 'text-rose-500 dark:text-rose-400',
      containerClass: CATEGORY_CONTAINER_CLASSES[category],
    };
  }
  return {
    category,
    asset: CATEGORY_ASSETS[category] || documentIcon,
    containerClass: CATEGORY_CONTAINER_CLASSES[category],
  };
}
