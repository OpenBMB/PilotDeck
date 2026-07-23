const CJK_PATTERN = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60]/u;

const WINDOWS_CJK = /microsoft yahei|dengxian|simhei|simsun|fangsong|kaiti/i;
const MACOS_CJK = /pingfang|hiragino|stheiti|heiti sc|songti sc|kaiti sc/i;
const RENDER_CJK = /noto sans cjk|source han sans|noto serif cjk|source han serif/i;
const LATIN_ONLY_DEFAULT = /^(?:arial|aptos(?: display)?|calibri|helvetica)$/i;

export function containsCjk(text) {
  return CJK_PATTERN.test(String(text ?? ''));
}

function warning(code, fontFace, message) {
  return { code, fontFace: fontFace || null, message };
}

export function analyzeTypography(manifest, options = {}) {
  const targetPlatform = options.targetPlatform || 'cross-platform';
  if (!['cross-platform', 'windows', 'macos', 'libreoffice'].includes(targetPlatform)) {
    throw new Error(`Unknown target platform: ${targetPlatform}`);
  }
  const cjkSlides = manifest.slides.filter((slide) => containsCjk(slide.text)).map((slide) => slide.number);
  const latinSlides = manifest.slides.filter((slide) => /[A-Za-z]/.test(slide.text)).map((slide) => slide.number);
  const usage = manifest.fontUsage ?? [];
  const explicitCjkFonts = usage.filter((item) => item.cjkObjectCount > 0).map((item) => item.fontFace);
  const relevantFonts = [...new Set(explicitCjkFonts.length ? explicitCjkFonts : usage.map((item) => item.fontFace))]
    .filter(Boolean);
  const warnings = [];

  if (cjkSlides.length && !relevantFonts.length) {
    warnings.push(warning(
      'cjk_font_implicit',
      null,
      'Chinese text has no explicit font declaration; PowerPoint and LibreOffice may choose different fallback fonts',
    ));
  }

  if (cjkSlides.length) {
    for (const fontFace of relevantFonts) {
      if (/^arial unicode ms$/i.test(fontFace)) {
        warnings.push(warning(
          'legacy_cjk_font_availability',
          fontFace,
          `${fontFace} is not guaranteed on modern Windows and macOS installations`,
        ));
      } else if (LATIN_ONLY_DEFAULT.test(fontFace)) {
        warnings.push(warning(
          'cjk_font_substitution_expected',
          fontFace,
          `${fontFace} may rely on platform-specific fallback for Chinese glyphs; preserve extra text-box capacity`,
        ));
      }

      if (targetPlatform === 'cross-platform' && (WINDOWS_CJK.test(fontFace) || MACOS_CJK.test(fontFace))) {
        warnings.push(warning(
          'platform_specific_font',
          fontFace,
          `${fontFace} is platform-specific; verify substitution on both macOS and Windows PowerPoint`,
        ));
      } else if (targetPlatform === 'windows' && MACOS_CJK.test(fontFace)) {
        warnings.push(warning('platform_specific_font', fontFace, `${fontFace} is not a safe Windows default`));
      } else if (targetPlatform === 'macos' && WINDOWS_CJK.test(fontFace)) {
        warnings.push(warning('platform_specific_font', fontFace, `${fontFace} is not a safe macOS default`));
      } else if (targetPlatform === 'libreoffice' && !RENDER_CJK.test(fontFace)) {
        warnings.push(warning(
          'renderer_font_substitution_expected',
          fontFace,
          `${fontFace} may be substituted by the LibreOffice rendering baseline`,
        ));
      }
    }
  }

  const deduped = [...new Map(warnings.map((item) => [`${item.code}:${item.fontFace || ''}`, item])).values()];
  return {
    status: deduped.length ? 'passed_with_warnings' : 'passed',
    targetPlatform,
    languages: {
      hasCjk: cjkSlides.length > 0,
      hasLatin: latinSlides.length > 0,
      cjkSlides,
      latinSlides,
    },
    declaredFonts: usage,
    theme: manifest.theme,
    warnings: deduped,
    guidance: cjkSlides.length
      ? 'PowerPoint is the target viewer. LibreOffice is a rendering baseline and may substitute Chinese fonts differently.'
      : 'Use a shared Latin font or the supplied template theme for cross-platform stability.',
  };
}
