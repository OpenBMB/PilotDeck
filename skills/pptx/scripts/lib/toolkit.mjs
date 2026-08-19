import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeTemplatePptx } from './ooxml.mjs';
import { loadDependencies } from './runtime.mjs';

export const disposeToolkit = Symbol('disposeToolkit');
export const templateSpeakerNotes = Symbol('templateSpeakerNotes');

export async function imageSizingCrop(imagePath, x, y, w, h) {
  const { sharp } = loadDependencies();
  const metadata = await sharp(path.resolve(imagePath)).metadata();
  if (!metadata.width || !metadata.height) throw new Error(`Unable to read image dimensions: ${imagePath}`);
  const sourceRatio = metadata.width / metadata.height;
  return {
    path: path.resolve(imagePath), x, y, w: sourceRatio, h: 1,
    sizing: { type: 'cover', w, h },
    transparency: 0,
  };
}

export async function imageSizingContain(imagePath, x, y, w, h) {
  const { sharp } = loadDependencies();
  const metadata = await sharp(path.resolve(imagePath)).metadata();
  if (!metadata.width || !metadata.height) throw new Error(`Unable to read image dimensions: ${imagePath}`);
  const sourceRatio = metadata.width / metadata.height;
  const targetRatio = w / h;
  let drawW = w;
  let drawH = h;
  if (sourceRatio > targetRatio) drawH = w / sourceRatio;
  else drawW = h * sourceRatio;
  return {
    path: path.resolve(imagePath),
    x: x + (w - drawW) / 2,
    y: y + (h - drawH) / 2,
    w: drawW,
    h: drawH,
  };
}

export async function createDeck(options = {}) {
  const { PptxGenJS } = loadDependencies();
  const pptx = new PptxGenJS();
  pptx.layout = options.layout ?? 'LAYOUT_WIDE';
  if (options.author) pptx.author = options.author;
  if (options.company) pptx.company = options.company;
  if (options.subject) pptx.subject = options.subject;
  if (options.title) pptx.title = options.title;
  const lang = options.lang ?? 'en-US';
  const headFontFace = options.headFontFace ?? 'Arial';
  const bodyFontFace = options.bodyFontFace ?? headFontFace;
  pptx.lang = lang;
  pptx.theme = {
    headFontFace,
    bodyFontFace,
    lang,
  };
  return pptx;
}

export async function createTemplatePresentation(inputPath, options = {}) {
  if (!inputPath) throw new Error('Template editing requires build --input source.pptx');
  if (!options.outputPath) throw new Error('Template presentation output context is unavailable');
  const { Automizer, automizerModule } = loadDependencies();
  const source = path.resolve(inputPath);
  const output = path.resolve(options.outputPath);
  const preparedSource = path.join(
    path.dirname(output),
    `.${path.basename(source, path.extname(source))}.${process.pid}.${Date.now()}.${crypto.randomBytes(5).toString('hex')}.template.pptx`,
  );
  options.registerTemporaryFile?.(preparedSource);
  await normalizeTemplatePptx(source, preparedSource);
  const sourceAlias = options.alias ?? '__pilotdeck_source__';
  const presentation = new Automizer({
    templateDir: path.dirname(preparedSource),
    outputDir: path.dirname(output),
    mediaDir: path.dirname(source),
    autoImportSlideMasters: true,
    removeExistingSlides: true,
    cleanup: false,
    cleanupPlaceholders: false,
    useCreationIds: false,
    verbosity: options.verbose ? 1 : 0,
  })
    .loadRoot(path.basename(preparedSource))
    .load(path.basename(preparedSource), sourceAlias);
  const speakerNotes = new Map();
  const template = {
    presentation,
    sourceAlias,
    source,
    loadMedia(filePath, name = path.basename(filePath)) {
      presentation.loadMedia(name, path.dirname(path.resolve(filePath)));
      return name;
    },
    addSlide(slideNumber, modifySlide) {
      presentation.addSlide(sourceAlias, slideNumber, modifySlide);
      return presentation;
    },
    automizer: automizerModule,
    ModifyTextHelper: automizerModule.ModifyTextHelper,
    ModifyImageHelper: automizerModule.ModifyImageHelper,
    modify: automizerModule.modify,
    setNotes(outputSlideNumber, notes) {
      if (!Number.isInteger(outputSlideNumber) || outputSlideNumber < 1) {
        throw new Error('Speaker notes require a positive output slide number');
      }
      const text = Array.isArray(notes) ? notes.join('\n') : notes;
      if (typeof text !== 'string') throw new Error('Speaker notes must be a string or an array of strings');
      speakerNotes.set(outputSlideNumber, text);
      return template;
    },
    [templateSpeakerNotes]: speakerNotes,
  };
  return template;
}

export async function buildToolkit(options = {}) {
  const deps = loadDependencies();
  const temporaryFiles = new Set();
  const toolkit = {
    createDeck,
    pptxgenjs: deps.PptxGenJS,
    inputPath: options.inputPath ? path.resolve(options.inputPath) : null,
    createTemplatePresentation: (templatePath = options.inputPath, templateOptions = {}) => createTemplatePresentation(
      templatePath,
      {
        ...templateOptions,
        outputPath: options.outputPath,
        registerTemporaryFile: (file) => temporaryFiles.add(file),
      },
    ),
    imageSizingCrop,
    imageSizingContain,
  };
  Object.defineProperty(toolkit, disposeToolkit, {
    value: async () => {
      await Promise.all([...temporaryFiles].map((file) => fs.rm(file, { force: true }).catch(() => {})));
    },
  });
  return toolkit;
}
