export function attachmentPreviewKind(file: Pick<File, 'name' | 'type'>) {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  if (file.type.startsWith('image/') || /^(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/.test(extension)) return 'image';
  if (extension === 'docx' || extension === 'pptx' || extension === 'xlsx') return extension;
  if (file.type === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('text/') || /^(json|xml|ya?ml|md|markdown|txt|csv|log|js|jsx|ts|tsx|py|rs|go|java|css|html|sh|sql|toml)$/.test(extension)) return 'text';
  return 'unsupported';
}
