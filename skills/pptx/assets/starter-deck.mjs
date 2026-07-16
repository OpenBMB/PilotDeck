export default async function build({ createDeck, layouts, tokens }) {
  const pptx = await createDeck({
    title: 'PilotDeck PPTX Skill',
    subject: 'A self-test presentation generated from an executable ES module',
  });

  layouts.titleSlide(pptx, tokens, {
    eyebrow: 'PilotDeck presentation runtime',
    title: 'Native PowerPoint, built as code',
    subtitle: 'Editable output with rendering and quality gates built into the workflow.',
    meta: 'PilotDeck · JavaScript · PPTX',
  });

  layouts.sectionSlide(pptx, tokens, {
    number: 1,
    title: 'A repeatable production path',
    subtitle: 'Narrative planning, native authoring, full rendering, and structural validation.',
    footer: 'PilotDeck PPTX Skill',
    page: 2,
  });

  layouts.metricSlide(pptx, tokens, {
    kicker: 'Quality gates',
    title: 'Verification is part of generation',
    metrics: [
      { value: '100%', label: 'slides rendered', detail: 'Every page becomes a PNG.' },
      { value: '0', label: 'canvas overflows', detail: 'Bounds are checked in OOXML.' },
      { value: '1×', label: 'reproducible build', detail: 'The source .mjs stays with the work.' },
    ],
    source: 'PilotDeck self-test',
    page: 3,
  });

  layouts.timelineSlide(pptx, tokens, {
    kicker: 'Workflow',
    title: 'From brief to verified presentation',
    steps: [
      { label: 'Plan', detail: 'Define the audience and takeaway.' },
      { label: 'Build', detail: 'Generate native PowerPoint objects.' },
      { label: 'Render', detail: 'Inspect every slide as an image.' },
      { label: 'Audit', detail: 'Fix overflow, overlap, and data issues.' },
    ],
    footer: 'PilotDeck PPTX Skill',
    page: 4,
  });

  layouts.closingSlide(pptx, tokens, {
    title: 'Build once. Inspect everything.',
    action: 'Keep the deck editable, the source reproducible, and the quality visible.',
    contact: 'PilotDeck PPTX Skill',
  });

  return pptx;
}
