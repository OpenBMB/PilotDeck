export type MarkdownArtifactFile = {
  name: string;
  path: string;
};

type MarkdownAstNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownAstNode[];
};

const decodePath = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeFiles = (files: MarkdownArtifactFile[]): MarkdownArtifactFile[] => (
  files
    .filter((file) => (
      typeof file?.name === 'string'
      && file.name.trim().length > 0
      && typeof file.path === 'string'
      && file.path.trim().length > 0
    ))
    .map((file) => ({ name: file.name.trim(), path: file.path.trim() }))
    .sort((left, right) => right.name.length - left.name.length)
);

const collectText = (node: MarkdownAstNode): string => {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value || '';
  return node.children?.map(collectText).join('') || '';
};

const findArtifactFile = (
  label: string,
  destination: string,
  files: MarkdownArtifactFile[],
): MarkdownArtifactFile | null => {
  const decodedDestination = decodePath(destination).replace(/\\/g, '/');
  return files.find((file) => (
    label.includes(file.name) || decodedDestination.includes(file.name)
  )) || null;
};

const MALFORMED_MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\n]+)\)/gu;

const stripMalformedArtifactLinks = (
  value: string,
  files: MarkdownArtifactFile[],
): string => value.replace(
  MALFORMED_MARKDOWN_LINK_PATTERN,
  (fullMatch, label: string, destination: string) => (
    findArtifactFile(label, destination, files) ? label : fullMatch
  ),
);

const transformChildren = (node: MarkdownAstNode, files: MarkdownArtifactFile[]) => {
  if (!node.children) return;

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child.type === 'link') {
      const file = findArtifactFile(collectText(child), child.url || '', files);
      if (file) {
        const replacement = child.children?.length
          ? child.children
          : [{ type: 'text', value: collectText(child) }];
        node.children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      }
      continue;
    }
    if (child.type === 'code' || child.type === 'inlineCode') continue;
    if (child.type === 'text') {
      child.value = stripMalformedArtifactLinks(child.value || '', files);
      continue;
    }
    transformChildren(child, files);
  }
};

export function createRemarkArtifactFileTextPlugin(files: MarkdownArtifactFile[]) {
  const normalizedFiles = normalizeFiles(files);
  return function remarkArtifactFileText() {
    return (tree: MarkdownAstNode) => {
      if (normalizedFiles.length > 0) transformChildren(tree, normalizedFiles);
    };
  };
}
