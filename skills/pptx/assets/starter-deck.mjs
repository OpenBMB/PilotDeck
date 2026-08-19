export default async function build({ createDeck }) {
  const pptx = await createDeck({ title: 'Presentation' });
  const fontFace = 'Arial';

  const cover = pptx.addSlide();
  cover.background = { color: 'FFFFFF' };
  cover.addText('A clear presentation title', {
    objectName: 'Deck Title',
    x: 0.9, y: 1.6, w: 11.4, h: 1.1,
    fontFace,
    fontSize: 36,
    bold: true,
    color: '1F2937',
    margin: 0,
    fit: 'shrink',
  });
  cover.addText('Use one sentence to frame the purpose, audience, or decision.', {
    objectName: 'Deck Subtitle',
    x: 0.92, y: 2.95, w: 9.5, h: 0.7,
    fontFace,
    fontSize: 18,
    color: '667085',
    margin: 0,
    fit: 'shrink',
  });
  cover.addShape(pptx.ShapeType.line, {
    objectName: 'Title Rule',
    x: 0.92, y: 4.25, w: 2.1, h: 0,
    line: { color: '94A3B8', width: 2 },
  });

  const content = pptx.addSlide();
  content.background = { color: 'FFFFFF' };
  content.addText('One slide, one communication job', {
    objectName: 'Slide Title',
    x: 0.78, y: 0.62, w: 11.7, h: 0.55,
    fontFace,
    fontSize: 28,
    bold: true,
    color: '1F2937',
    margin: 0,
    fit: 'shrink',
  });
  content.addText([
    { text: 'Replace this example with the content and visual structure that best serves the request.', options: { bullet: { indent: 18 }, breakLine: true } },
    { text: 'Use the complete PptxGenJS API or optional helpers; this starter is not a required layout.', options: { bullet: { indent: 18 } } },
  ], {
    objectName: 'Body',
    x: 1.0, y: 1.65, w: 8.9, h: 2.4,
    fontFace,
    fontSize: 18,
    color: '344054',
    margin: 0.08,
    breakLine: false,
    valign: 'mid',
  });

  return pptx;
}
