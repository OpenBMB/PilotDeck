import { test, expect } from './fixtures/scroll-test.mjs';

test.beforeEach(async ({ page, baseURL }) => {
  await page.route('**/api/config', route => route.fulfill({ json: {} }));
  await page.goto(new URL('/e2e/fixtures/streaming-scroll.html', baseURL).href);
});

const viewport = page => page.locator('[data-chat-search-surface]');
const portrait = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="640"><rect width="320" height="640" fill="#386c91"/></svg>';

async function syntheticVideo(browser) {
  // In-memory, silent synthetic media; no provider, user data or external URL.
  // Encode in Chromium for both targets: this suite tests the target's decoder,
  // not platform-specific canvas capture/encoder availability in Electron.
  const page = await browser.newPage();
  try { return Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 320;
    const context = canvas.getContext('2d'); context.fillStyle = '#386c91'; context.fillRect(0, 0, 180, 320);
    document.body.append(canvas);
    const stream = canvas.captureStream(0);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    const started = new Promise(resolve => { recorder.onstart = resolve; });
    recorder.start();
    await started;
    // Chrome can subscribe to canvas frames after start() returns. Produce
    // distinct frames after the start event instead of racing one initial draw.
    for (let frame = 0; frame < 6; frame++) {
      context.fillStyle = frame % 2 ? '#41769a' : '#386c91'; context.fillRect(0, 0, 180, 320);
      stream.getVideoTracks()[0].requestFrame();
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    recorder.stop();
    await stopped; stream.getTracks().forEach(track => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  })); } finally { await page.close(); }
}

async function mediaFixture(page, browser, count, hold = false) {
  const video = await syntheticVideo(browser);
  expect(video.length, 'synthetic WebM must contain encoded frames').toBeGreaterThan(200);
  let release;
  const gate = hold ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  await page.route('**/api/image-generation/scroll-media/*', async route => {
    await gate; await new Promise(resolve => setTimeout(resolve, 80));
    await route.fulfill({ contentType: 'image/svg+xml', body: portrait });
  });
  await page.route('**/api/video-generation/scroll-media/*', async route => {
    await gate; await new Promise(resolve => setTimeout(resolve, 120));
    await route.fulfill({ contentType: 'video/webm', body: video });
  });
  await page.evaluate(count => window.streamFixture.mediaHistory(count), count);
  await expect.poll(() => viewport(page).evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(3);
  return () => release?.();
}

test('image decoding and video metadata preserve the reserved card geometry', async ({ page, browser }) => {
  const release = await mediaFixture(page, browser, 2, true);
  const image = page.locator('.generated-image-surface').first();
  const video = page.locator('.video-player video').first();
  await expect(image).toHaveCount(1); await expect(video).toHaveCount(1);
  // Navigate to the media turn before releasing the response, as a reader would.
  await page.locator('[data-turn-index="1"]').click();
  await expect(video).toBeInViewport();
  const before = { image: await image.evaluate(node => node.getBoundingClientRect().height), video: await video.evaluate(node => node.getBoundingClientRect().height) };
  release();
  await expect(image.locator('.is-loaded')).toHaveCount(1);
  await expect.poll(() => video.evaluate(node => ({ loaded: node.readyState > 0, error: node.error?.message ?? null, network: node.networkState })))
    .toMatchObject({ loaded: true, error: null });
  expect(await image.evaluate(node => node.getBoundingClientRect().height)).toBeCloseTo(before.image, 0);
  expect(await video.evaluate(node => node.getBoundingClientRect().height)).toBeCloseTo(before.video, 0);
});

test('bidirectional wheels through virtualized delayed media retain each reading displacement', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await mediaFixture(page, browser, 100);
  await expect(page.locator('[data-virtualized-messages="true"]')).toHaveCount(1);
  // scrollTop is quantized to device pixels, while DOM rectangles retain
  // fractional CSS pixels (including on Windows 125/150/175% displays).
  const pixel = await page.evaluate(() => 1 / devicePixelRatio + 1 / 64);
  await viewport(page).hover({ position: { x: 200, y: 300 } });
  for (const delta of [...Array(35).fill(-480), ...Array(24).fill(480), ...Array(20).fill(-480)]) {
    await viewport(page).evaluate(node => node.addEventListener('wheel', () => {
      const edge = node.getBoundingClientRect().top;
      const row = [...node.querySelectorAll('.chat-message[data-message-key]')].find(row => row.getBoundingClientRect().bottom > edge);
      window.mediaReading = { key: row.dataset.messageKey, y: row.getBoundingClientRect().top };
    }, { once: true, capture: true }));
    await page.mouse.wheel(0, delta);
    await expect.poll(() => viewport(page).evaluate((node, delta) => {
      const anchor = window.mediaReading;
      const row = [...node.querySelectorAll('.chat-message[data-message-key]')].find(row => row.dataset.messageKey === anchor.key);
      return row ? Math.abs(row.getBoundingClientRect().top - anchor.y + delta) : Infinity;
    }, delta), { timeout: 3000 }).toBeLessThanOrEqual(pixel);
    const settled = await viewport(page).evaluate(async node => {
      const positions = [];
      for (let frame = 0; frame < 4; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const row = [...node.querySelectorAll('.chat-message[data-message-key]')].find(row => row.dataset.messageKey === window.mediaReading.key);
        positions.push(row?.getBoundingClientRect().top ?? NaN);
      }
      return positions;
    });
    expect(Math.max(...settled) - Math.min(...settled)).toBeLessThanOrEqual(pixel);
    await expect(viewport(page)).toHaveAttribute('data-scroll-follow-paused', 'true');
  }
  await page.getByRole('button', { name: 'Back to latest' }).click();
  await expect.poll(() => viewport(page).evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(3);
});
