const IMAGE_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'avif',
];

const PDF_EXTENSIONS = ['pdf'];

const OFFICE_EXTENSIONS = [
  'doc', 'docx', 'wps', 'xls', 'xlsx', 'et', 'ppt', 'pptx', 'dps', 'odt', 'ods', 'odp',
];

const SPREADSHEET_EXTENSIONS = ['xls', 'xlsx', 'et', 'ods'];

const BINARY_EXTENSIONS = [
  // Images
  ...IMAGE_EXTENSIONS,
  // Archives
  'zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz',
  // Executables
  'exe', 'dll', 'so', 'dylib', 'app', 'dmg', 'msi',
  // Media
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'm4a', 'ogg',
  // Documents
  ...PDF_EXTENSIONS, ...OFFICE_EXTENSIONS,
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // Database
  'db', 'sqlite', 'sqlite3',
  // Other binary
  'bin', 'dat', 'iso', 'img', 'class', 'jar', 'war', 'pyc', 'pyo'
];

const getExtension = (filename: string): string =>
  filename.split('.').pop()?.toLowerCase() ?? '';

export const isBinaryFile = (filename: string): boolean =>
  BINARY_EXTENSIONS.includes(getExtension(filename));

export const isImageFile = (filename: string): boolean =>
  IMAGE_EXTENSIONS.includes(getExtension(filename));

export const isPdfFile = (filename: string): boolean =>
  PDF_EXTENSIONS.includes(getExtension(filename));

export const isOfficeFile = (filename: string): boolean =>
  OFFICE_EXTENSIONS.includes(getExtension(filename));

export const isSpreadsheetFile = (filename: string): boolean =>
  SPREADSHEET_EXTENSIONS.includes(getExtension(filename));
