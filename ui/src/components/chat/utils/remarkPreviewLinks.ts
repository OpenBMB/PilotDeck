type MarkdownNode = {
  type: string;
  url?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: MarkdownNode[];
};

export function parseLoopbackPreviewUrl(href: string): URL | null {
  try {
    const url = new URL(href);
    if (
      url.href === href
      && url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && url.port && url.port !== '0'
      && !url.username && !url.password && !url.hash
    ) return url;
  } catch {
    // Relative and invalid destinations use the ordinary Markdown rendering.
  }
  return null;
}

export function remarkPreviewLinks() {
  return function visit(node: MarkdownNode): void {
    if (node.type === 'link' && node.url && parseLoopbackPreviewUrl(node.url)) {
      // mdast-to-hast otherwise encodes IPv6 brackets and alters literal query bytes.
      node.data ??= {};
      node.data.hProperties = { ...node.data.hProperties, href: node.url };
    }
    node.children?.forEach(visit);
  };
}
