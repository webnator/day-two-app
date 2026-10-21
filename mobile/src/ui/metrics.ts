// Tinos Regular vertical metrics (hhea, 2048 upm). Browsers place the glyph content area
// (ascent + descent) centered in the line box; these helpers reproduce CSS positions.
export const ASCENT = 1825 / 2048;
export const DESCENT = 443 / 2048;

/** Distance from the top of a line box to the alphabetic baseline. */
export function baselineOf(size: number, lineHeight: number): number {
  return (lineHeight - (ASCENT + DESCENT) * size) / 2 + ASCENT * size;
}

/** Offset to apply to B so that its baseline aligns with A's (CSS `align-items: baseline`). */
export function baselineShift(a: { size: number; lh: number }, b: { size: number; lh: number }): number {
  return baselineOf(a.size, a.size * a.lh) - baselineOf(b.size, b.size * b.lh);
}

/**
 * UITextView (multiline TextInput on iOS) adds the font's line gap to every line, and places the
 * first line lower than a Text does. Values measured against Chromium (tools/visual, editor scenario).
 */
export const IOS_INPUT_LINE_GAP = 87 / 2048;
export const IOS_INPUT_FIRST_LINE = { title: 1.0, body: -2.5 };

/**
 * Visual correction so a native line box places glyphs where Chromium does.
 * Chromium: baseline = L/2 + (ASCENT - (ASCENT + DESCENT)/2)·s (half-leading around ascent+descent).
 * RN iOS (RCTApplyBaselineOffset): when L ≥ UIFont.lineHeight (1.15 s with Tinos' line gap) the glyphs
 * are centred on the font line height; when L is smaller, they sit at the bottom of the line box.
 * Returned value is a translateY in points (layout boxes keep the CSS heights).
 */
const LINE_GAP = 87 / 2048;
export function iosGlyphShift(size: number, lineHeight: number): number {
  const chrome = lineHeight / 2 + (ASCENT - (ASCENT + DESCENT) / 2) * size;
  const fontLine = (ASCENT + DESCENT + LINE_GAP) * size;
  const native = lineHeight >= fontLine ? lineHeight / 2 + fontLine / 2 - DESCENT * size : lineHeight - DESCENT * size;
  return chrome - native;
}
