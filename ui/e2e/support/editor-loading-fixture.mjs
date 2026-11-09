export const projectName = 'editor-loading-fixture';
export const initialText = 'export const answer = 42;\n';

// Two pages, no author/creation metadata or external assets. Keeping the PDF
// generator here makes the document's synthetic provenance inspectable.
function makePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, label] of [[3, 'Synthetic page one'], [5, 'Synthetic page two']]) {
    const content = `BT /F1 20 Tf 30 550 Td (${label}) Tj ET\n`;
    objects[index] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`;
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

export async function installEditorFixture(page, baseURL) {
  const origin = new URL(baseURL).origin;
  const foreignRequests = [];
  const pdf = makePdf();
  const textFiles = new Map([['first.ts', initialText], ['second.ts', 'export const second = true;\n']]);
  const fileKey = value => value?.replace(/^\/fixture\//, '');
  const project = { name: projectName, displayName: 'Editor loading fixture', fullPath: '/fixture',
    sessions: [], sessionMeta: { total: 0, hasMore: false } };
  await page.addInitScript(() => {
    localStorage.setItem('userLanguage', 'en');
    localStorage.setItem('themeMode', 'light');
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    let body = {};
    if (pathname === '/api/auth/status') body = { authDisabled: true };
    else if (pathname === '/api/settings/permissions') body = { success: true, permissions: {
      skipPermissions: false, allowedTools: [], askTools: [], disallowedTools: [],
    } };
    else if (pathname.includes('onboarding-status')) body = {
      configuration: { state: 'ready', modelRef: 'fixture/model', revision: '' }, gateway: { state: 'ready' },
    };
    else if (pathname === '/api/projects') body = [project];
    else if (pathname === `/api/projects/${projectName}/files`) body = ['first.ts', 'second.ts', 'sample.pdf']
      .map(name => ({ name, type: 'file', path: `/fixture/${name}`, size: 100 }));
    else if (pathname === `/api/projects/${projectName}/file`) {
      if (route.request().method() === 'PUT') {
        const data = route.request().postDataJSON();
        textFiles.set(fileKey(data.filePath), data.content);
        body = { success: true };
      } else body = { content: textFiles.get(fileKey(url.searchParams.get('filePath'))) ?? '' };
    } else if (pathname === `/api/projects/${projectName}/files/content`) {
      await route.fulfill({ contentType: 'application/pdf', body: pdf }); return;
    } else if (pathname.includes('/plugins')) body = { plugins: [] };
    else if (pathname.includes('/tasks')) body = { tasks: [] };
    else if (pathname.includes('/skills')) body = { skills: [] };
    else if (pathname.includes('runtime-status')) body = { gateway: { state: 'ready' } };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  // Register last so every HTTP route, including /api URLs, first passes the
  // isolation boundary. An accidental external dependency must fail the test.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) {
      foreignRequests.push(url.href);
      await route.abort('blockedbyclient');
    } else await route.fallback();
  });
  await page.routeWebSocket('**/*', socket => {
    if (new URL(socket.url()).host !== new URL(baseURL).host) {
      foreignRequests.push(socket.url());
      socket.close({ code: 1008, reason: 'Unexpected external endpoint' });
    } else socket.onMessage(() => {});
  });
  return { textFiles, foreignRequests };
}
