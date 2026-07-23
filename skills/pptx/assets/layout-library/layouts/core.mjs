const W = 13.333;
const H = 7.5;

function addBackground(pptx, slide, color, name = 'Background') {
  slide.background = { color };
  slide.addShape(pptx.ShapeType.rect, {
    objectName: name,
    x: 0,
    y: 0,
    w: W,
    h: H,
    line: { color, transparency: 100 },
    fill: { color },
  });
}

function addFooter(slide, tokens, footer, page, inverse = false) {
  const color = inverse ? 'D7E2EA' : tokens.colors.muted;
  if (footer) {
    slide.addText(footer, {
      objectName: 'Footer',
      x: 0.72,
      y: 7.05,
      w: 10.6,
      h: 0.18,
      fontFace: tokens.typography.bodyFontFace,
      fontSize: tokens.typography.caption,
      color,
      margin: 0,
      breakLine: false,
    });
  }
  if (page !== undefined && page !== null) {
    slide.addText(String(page).padStart(2, '0'), {
      objectName: 'Page Number',
      x: 11.95,
      y: 7.02,
      w: 0.65,
      h: 0.2,
      align: 'right',
      fontFace: tokens.typography.bodyFontFace,
      fontSize: tokens.typography.caption,
      bold: true,
      color,
      margin: 0,
      breakLine: false,
    });
  }
}

function addTitle(slide, tokens, title, kicker) {
  if (kicker) {
    slide.addText(kicker.toUpperCase(), {
      objectName: 'Kicker',
      x: 0.72,
      y: 0.55,
      w: 4.4,
      h: 0.24,
      fontFace: tokens.typography.bodyFontFace,
      fontSize: 12,
      bold: true,
      charSpacing: 1.4,
      color: tokens.colors.accent,
      margin: 0,
      breakLine: false,
    });
  }
  slide.addText(title, {
    objectName: 'Slide Title',
    x: 0.72,
    y: kicker ? 0.88 : 0.64,
    w: 11.75,
    h: 0.55,
    fontFace: tokens.typography.headFontFace,
    fontSize: tokens.typography.slideTitle,
    bold: true,
    color: tokens.colors.ink,
    margin: 0,
    breakLine: false,
    fit: 'shrink',
  });
}

function toRuns(items, tokens) {
  return items.flatMap((item, index) => [
    { text: item, options: { bullet: { indent: 18 }, hanging: 4, breakLine: index < items.length - 1 } },
  ]).map((run) => ({
    ...run,
    options: { ...run.options, fontFace: tokens.typography.bodyFontFace, fontSize: tokens.typography.body, color: tokens.colors.ink },
  }));
}

export function titleSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.navy);
  slide.addShape(pptx.ShapeType.line, {
    objectName: 'Title Accent',
    x: 0.74,
    y: 1.32,
    w: 1.25,
    h: 0,
    line: { color: tokens.colors.accent, width: 4 },
  });
  if (content.eyebrow) {
    slide.addText(content.eyebrow.toUpperCase(), {
      objectName: 'Eyebrow', x: 0.74, y: 0.72, w: 4.8, h: 0.25,
      fontFace: tokens.typography.bodyFontFace, fontSize: 12, bold: true,
      charSpacing: 1.5, color: 'C7D8E5', margin: 0, breakLine: false,
    });
  }
  slide.addText(content.title ?? 'A clear presentation title', {
    objectName: 'Deck Title', x: 0.74, y: 1.62, w: 10.8, h: 1.35,
    fontFace: tokens.typography.headFontFace, fontSize: tokens.typography.deckTitle,
    bold: true, color: tokens.colors.white, margin: 0, breakLine: false, fit: 'shrink',
  });
  if (content.subtitle) {
    slide.addText(content.subtitle, {
      objectName: 'Deck Subtitle', x: 0.76, y: 3.28, w: 8.8, h: 0.78,
      fontFace: tokens.typography.bodyFontFace, fontSize: tokens.typography.subheading,
      color: 'D7E2EA', margin: 0, breakLine: false, fit: 'shrink',
    });
  }
  if (content.meta) {
    slide.addText(content.meta, {
      objectName: 'Deck Meta', x: 0.76, y: 6.48, w: 7.6, h: 0.24,
      fontFace: tokens.typography.bodyFontFace, fontSize: 12,
      color: 'A9BECC', margin: 0, breakLine: false,
    });
  }
  return slide;
}

export function sectionSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.paper);
  slide.addText(String(content.number ?? '01').padStart(2, '0'), {
    objectName: 'Section Number', x: 0.72, y: 0.72, w: 1.1, h: 0.65,
    fontFace: tokens.typography.headFontFace, fontSize: 42, bold: true,
    color: tokens.colors.accent, margin: 0, breakLine: false,
  });
  slide.addShape(pptx.ShapeType.line, {
    objectName: 'Section Rule', x: 0.76, y: 1.55, w: 11.82, h: 0,
    line: { color: tokens.colors.rule, width: 1.3 },
  });
  slide.addText(content.title ?? 'Section title', {
    objectName: 'Section Title', x: 2.12, y: 2.25, w: 9.6, h: 0.9,
    fontFace: tokens.typography.headFontFace, fontSize: 44, bold: true,
    color: tokens.colors.ink, margin: 0, breakLine: false, fit: 'shrink',
  });
  if (content.subtitle) {
    slide.addText(content.subtitle, {
      objectName: 'Section Subtitle', x: 2.14, y: 3.42, w: 8.5, h: 0.65,
      fontFace: tokens.typography.bodyFontFace, fontSize: 21,
      color: tokens.colors.muted, margin: 0, breakLine: false, fit: 'shrink',
    });
  }
  addFooter(slide, tokens, content.footer, content.page);
  return slide;
}

export function statementSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.white);
  slide.addShape(pptx.ShapeType.line, {
    objectName: 'Statement Accent', x: 0.74, y: 1.0, w: 0, h: 4.9,
    line: { color: tokens.colors.accent, width: 5 },
  });
  if (content.kicker) {
    slide.addText(content.kicker.toUpperCase(), {
      objectName: 'Statement Kicker', x: 1.18, y: 0.98, w: 4.5, h: 0.25,
      fontFace: tokens.typography.bodyFontFace, fontSize: 12, bold: true,
      charSpacing: 1.3, color: tokens.colors.accent, margin: 0, breakLine: false,
    });
  }
  slide.addText(content.statement ?? 'One memorable conclusion belongs here.', {
    objectName: 'Statement', x: 1.16, y: 1.55, w: 10.45, h: 2.35,
    fontFace: tokens.typography.headFontFace, fontSize: tokens.typography.statement,
    bold: true, color: tokens.colors.ink, margin: 0, valign: 'mid', fit: 'shrink',
  });
  if (content.support) {
    slide.addText(content.support, {
      objectName: 'Statement Support', x: 1.2, y: 4.5, w: 8.8, h: 0.75,
      fontFace: tokens.typography.bodyFontFace, fontSize: 20,
      color: tokens.colors.muted, margin: 0, fit: 'shrink',
    });
  }
  addFooter(slide, tokens, content.footer, content.page);
  return slide;
}

export function splitSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.paper);
  addTitle(slide, tokens, content.title ?? 'One argument, one visual', content.kicker);
  slide.addText(content.body ?? '', {
    objectName: 'Split Body', x: 0.74, y: 1.75, w: 4.65, h: 4.55,
    fontFace: tokens.typography.bodyFontFace, fontSize: tokens.typography.body,
    color: tokens.colors.ink, margin: 0, breakLine: false, valign: 'mid', fit: 'shrink',
  });
  if (content.image) {
    slide.addImage({ objectName: 'Split Image', x: 5.82, y: 1.62, w: 6.76, h: 4.8, ...content.image });
  } else {
    slide.addShape(pptx.ShapeType.rect, {
      objectName: 'Media Placeholder', x: 5.82, y: 1.62, w: 6.76, h: 4.8,
      fill: { color: 'E5EAF0' }, line: { color: 'CAD2DC', dash: 'dash' },
    });
  }
  addFooter(slide, tokens, content.footer, content.page);
  return slide;
}

export function twoColumnSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.white);
  addTitle(slide, tokens, content.title ?? 'Two dimensions', content.kicker);
  slide.addShape(pptx.ShapeType.line, {
    objectName: 'Column Divider', x: 6.66, y: 1.72, w: 0, h: 4.65,
    line: { color: tokens.colors.rule, width: 1.2 },
  });
  for (const [side, x] of [['left', 0.74], ['right', 7.02]]) {
    const column = content[side] ?? {};
    slide.addText(column.heading ?? '', {
      objectName: `${side} heading`, x, y: 1.75, w: 5.55, h: 0.38,
      fontFace: tokens.typography.headFontFace, fontSize: 24, bold: true,
      color: side === 'left' ? tokens.colors.navy : tokens.colors.accent,
      margin: 0, breakLine: false, fit: 'shrink',
    });
    slide.addText(toRuns(column.items ?? [], tokens), {
      objectName: `${side} body`, x, y: 2.42, w: 5.35, h: 3.72,
      fontFace: tokens.typography.bodyFontFace, fontSize: tokens.typography.body,
      color: tokens.colors.ink, margin: 0.04, paraSpaceAfterPt: 14, breakLine: false, fit: 'shrink',
    });
  }
  addFooter(slide, tokens, content.footer, content.page);
  return slide;
}

export function metricSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.paper);
  addTitle(slide, tokens, content.title ?? 'The numbers that matter', content.kicker);
  const metrics = (content.metrics ?? []).slice(0, 4);
  const count = Math.max(1, metrics.length);
  const available = 11.84;
  const width = available / count;
  metrics.forEach((metric, index) => {
    const x = 0.74 + index * width;
    if (index > 0) {
      slide.addShape(pptx.ShapeType.line, {
        objectName: `Metric Divider ${index}`, x, y: 2.06, w: 0, h: 3.2,
        line: { color: tokens.colors.rule, width: 1 },
      });
    }
    slide.addText(metric.value, {
      objectName: `Metric ${index + 1} Value`, x: x + 0.22, y: 2.22, w: width - 0.44, h: 0.85,
      fontFace: tokens.typography.headFontFace, fontSize: tokens.typography.metric,
      bold: true, color: index === 0 ? tokens.colors.accent : tokens.colors.navy,
      margin: 0, align: 'center', breakLine: false, fit: 'shrink',
    });
    slide.addText(metric.label, {
      objectName: `Metric ${index + 1} Label`, x: x + 0.22, y: 3.28, w: width - 0.44, h: 0.72,
      fontFace: tokens.typography.bodyFontFace, fontSize: 19, bold: true,
      color: tokens.colors.ink, margin: 0, align: 'center', fit: 'shrink',
    });
    if (metric.detail) {
      slide.addText(metric.detail, {
        objectName: `Metric ${index + 1} Detail`, x: x + 0.24, y: 4.28, w: width - 0.48, h: 0.65,
        fontFace: tokens.typography.bodyFontFace, fontSize: 14,
        color: tokens.colors.muted, margin: 0, align: 'center', fit: 'shrink',
      });
    }
  });
  addFooter(slide, tokens, content.source || content.footer, content.page);
  return slide;
}

export function comparisonSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.white);
  addTitle(slide, tokens, content.title ?? 'A useful comparison', content.kicker);
  const sides = [
    { key: 'left', x: 0.74, color: tokens.colors.navy, fill: 'EEF2F6' },
    { key: 'right', x: 6.76, color: tokens.colors.accent, fill: 'FFF0E9' },
  ];
  for (const side of sides) {
    const data = content[side.key] ?? {};
    slide.addShape(pptx.ShapeType.rect, {
      objectName: `${side.key} field`, x: side.x, y: 1.72, w: 5.82, h: 4.5,
      fill: { color: side.fill }, line: { color: side.fill }, radius: 0.08,
    });
    slide.addText(data.heading ?? '', {
      objectName: `${side.key} heading`, x: side.x + 0.38, y: 2.08, w: 5.05, h: 0.45,
      fontFace: tokens.typography.headFontFace, fontSize: 25, bold: true,
      color: side.color, margin: 0, breakLine: false, fit: 'shrink',
    });
    slide.addText(toRuns(data.items ?? [], tokens), {
      objectName: `${side.key} points`, x: side.x + 0.38, y: 2.82, w: 4.98, h: 2.75,
      fontFace: tokens.typography.bodyFontFace, fontSize: 17,
      color: tokens.colors.ink, margin: 0.03, paraSpaceAfterPt: 11, fit: 'shrink',
    });
  }
  if (content.takeaway) {
    slide.addText(content.takeaway, {
      objectName: 'Comparison Takeaway', x: 1.58, y: 6.43, w: 10.2, h: 0.34,
      fontFace: tokens.typography.bodyFontFace, fontSize: 15, bold: true,
      color: tokens.colors.ink, align: 'center', margin: 0, breakLine: false, fit: 'shrink',
    });
  }
  addFooter(slide, tokens, content.footer, content.page);
  return slide;
}

export function timelineSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.paper);
  addTitle(slide, tokens, content.title ?? 'A sequence with momentum', content.kicker);
  const steps = (content.steps ?? []).slice(0, 5);
  const startX = 1.18;
  const endX = 12.15;
  const y = 3.22;
  if (steps.length > 1) {
    slide.addShape(pptx.ShapeType.line, {
      objectName: 'Timeline Connector', x: startX, y, w: endX - startX, h: 0,
      line: { color: 'AAB7C4', width: 2.2 },
    });
  }
  steps.forEach((step, index) => {
    const x = steps.length === 1 ? (startX + endX) / 2 : startX + ((endX - startX) * index) / (steps.length - 1);
    slide.addShape(pptx.ShapeType.ellipse, {
      objectName: `Step ${index + 1} Node`, x: x - 0.18, y: y - 0.18, w: 0.36, h: 0.36,
      fill: { color: index === steps.length - 1 ? tokens.colors.accent : tokens.colors.navy },
      line: { color: tokens.colors.white, width: 1.5 },
    });
    slide.addText(step.label, {
      objectName: `Step ${index + 1} Label`, x: x - 0.92, y: 2.2, w: 1.84, h: 0.55,
      fontFace: tokens.typography.headFontFace, fontSize: 18, bold: true,
      color: tokens.colors.ink, margin: 0, align: 'center', valign: 'bottom', fit: 'shrink',
    });
    if (step.detail) {
      slide.addText(step.detail, {
        objectName: `Step ${index + 1} Detail`, x: x - 0.9, y: 3.72, w: 1.8, h: 1.2,
        fontFace: tokens.typography.bodyFontFace, fontSize: 13,
        color: tokens.colors.muted, margin: 0, align: 'center', fit: 'shrink',
      });
    }
  });
  addFooter(slide, tokens, content.footer, content.page);
  return slide;
}

export function chartSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.white);
  addTitle(slide, tokens, content.title ?? 'One quantitative comparison', content.kicker);
  slide.addChart(content.type ?? pptx.ChartType.bar, content.series ?? [], {
    objectName: 'Primary Chart', x: 0.76, y: 1.66, w: 8.55, h: 4.9,
    catAxisLabelFontFace: tokens.typography.bodyFontFace,
    catAxisLabelFontSize: Math.max(10, tokens.typography.caption + 1),
    valAxisLabelFontFace: tokens.typography.bodyFontFace,
    valAxisLabelFontSize: tokens.typography.caption,
    showLegend: (content.series ?? []).length > 1,
    showTitle: false,
    showValue: Boolean(content.showValue),
    chartColors: content.colors ?? [tokens.colors.navy, tokens.colors.accent, tokens.colors.cyan],
    showCatName: false,
    showValAxisTitle: false,
    showCatAxisTitle: false,
    showBorder: false,
  });
  if (content.takeaway) {
    slide.addText(content.takeaway, {
      objectName: 'Chart Takeaway', x: 9.78, y: 2.15, w: 2.6, h: 2.8,
      fontFace: tokens.typography.headFontFace, fontSize: 23, bold: true,
      color: tokens.colors.ink, margin: 0, valign: 'mid', fit: 'shrink',
    });
  }
  addFooter(slide, tokens, content.source || content.footer, content.page);
  return slide;
}

export function tableSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.paper);
  addTitle(slide, tokens, content.title ?? 'Exact values', content.kicker);
  slide.addTable(content.rows ?? [], {
    objectName: 'Primary Table', x: 0.76, y: 1.62, w: 11.82, h: 4.95,
    border: { type: 'solid', color: tokens.colors.rule, pt: 1 },
    fill: tokens.colors.white,
    color: tokens.colors.ink,
    fontFace: tokens.typography.bodyFontFace,
    fontSize: tokens.typography.table ?? 15,
    margin: 0.08,
    rowH: 0.54,
    bold: false,
    breakLine: false,
    autoFit: false,
  });
  addFooter(slide, tokens, content.source || content.footer, content.page);
  return slide;
}

export function quoteSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.navy);
  slide.addText('“', {
    objectName: 'Quote Mark', x: 0.76, y: 0.66, w: 1.0, h: 1.1,
    fontFace: 'Georgia', fontSize: 72, bold: true, color: tokens.colors.accent,
    margin: 0, breakLine: false,
  });
  slide.addText(content.quote ?? 'A short, useful quotation belongs here.', {
    objectName: 'Quote', x: 1.58, y: 1.38, w: 10.22, h: 2.55,
    fontFace: tokens.typography.headFontFace, fontSize: 34, bold: true,
    color: tokens.colors.white, margin: 0, valign: 'mid', fit: 'shrink',
  });
  slide.addShape(pptx.ShapeType.line, {
    objectName: 'Quote Rule', x: 1.6, y: 4.45, w: 1.1, h: 0,
    line: { color: tokens.colors.accent, width: 3 },
  });
  slide.addText(content.attribution ?? '', {
    objectName: 'Attribution', x: 1.6, y: 4.82, w: 6.2, h: 0.42,
    fontFace: tokens.typography.bodyFontFace, fontSize: 18, bold: true,
    color: 'D7E2EA', margin: 0, breakLine: false, fit: 'shrink',
  });
  if (content.context) {
    slide.addText(content.context, {
      objectName: 'Quote Context', x: 1.6, y: 5.38, w: 7.9, h: 0.38,
      fontFace: tokens.typography.bodyFontFace, fontSize: 13,
      color: 'A9BECC', margin: 0, breakLine: false, fit: 'shrink',
    });
  }
  addFooter(slide, tokens, content.footer, content.page, true);
  return slide;
}

export function closingSlide(pptx, tokens, content = {}) {
  const slide = pptx.addSlide();
  addBackground(pptx, slide, tokens.colors.navy);
  slide.addShape(pptx.ShapeType.line, {
    objectName: 'Closing Accent', x: 0.76, y: 1.25, w: 1.32, h: 0,
    line: { color: tokens.colors.accent, width: 4 },
  });
  slide.addText(content.title ?? 'Move the work forward.', {
    objectName: 'Closing Title', x: 0.76, y: 1.68, w: 10.85, h: 1.18,
    fontFace: tokens.typography.headFontFace, fontSize: 46, bold: true,
    color: tokens.colors.white, margin: 0, breakLine: false, fit: 'shrink',
  });
  if (content.action) {
    slide.addText(content.action, {
      objectName: 'Closing Action', x: 0.78, y: 3.34, w: 8.7, h: 0.8,
      fontFace: tokens.typography.bodyFontFace, fontSize: 23,
      color: 'D7E2EA', margin: 0, fit: 'shrink',
    });
  }
  if (content.contact) {
    slide.addText(content.contact, {
      objectName: 'Closing Contact', x: 0.78, y: 6.45, w: 7.8, h: 0.28,
      fontFace: tokens.typography.bodyFontFace, fontSize: 13,
      color: 'A9BECC', margin: 0, breakLine: false,
    });
  }
  return slide;
}
