import { createContext, useContext } from "react";
import { Platform, Text, type TextProps, type TextStyle, StyleSheet } from "react-native";
import { iosGlyphShift } from "./metrics";
import { ANDROID_TEXT_SHIFT, IOS_TEXT_SHIFT } from "./textCalibration";
import { accessibleColor, useHighContrast } from "./contrast";

/** Measured correction for this size/line-height pair; model-based fallback for pairs not in the mock. */
export function glyphShift(size: number, lineHeight: number): number {
  const key = `${size}/${Math.round(lineHeight * 100) / 100}`;
  if (Platform.OS === "ios") return IOS_TEXT_SHIFT[key] ?? iosGlyphShift(size, lineHeight);
  return ANDROID_TEXT_SHIFT[key] ?? 0;
}
import { C, SERIF } from "./theme";

/**
 * Text with the product defaults of `.phone` (20px/1.35 DaySerif, ink). `size` and `lh`
 * mirror CSS font-size and unitless line-height; the computed line height is size × lh,
 * like the browser.
 */
/** Inherited unitless line-height, like CSS: `.phone` 1.35, `.sheet` 1.4. */
export const LineHeight = createContext(1.35);
export const useLineHeight = () => useContext(LineHeight);

export function Txt({
  size = 20,
  lh: lhProp,
  color = C.ink,
  ls,
  align,
  style,
  ...rest
}: TextProps & { size?: number; lh?: number; color?: string; ls?: number; align?: TextStyle["textAlign"] }) {
  const inherited = useContext(LineHeight);
  const high = useHighContrast();
  const lh = lhProp ?? inherited;
  return (
    <Text
      maxFontSizeMultiplier={2}
      {...rest}
      style={[
        styles.base,
        { fontSize: size, lineHeight: size * lh, color: accessibleColor(color, high), letterSpacing: ls, textAlign: align },
        { transform: [{ translateY: glyphShift(size, size * lh) }] },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  base: { fontFamily: SERIF, fontWeight: "400", includeFontPadding: false, textAlignVertical: "center" } as TextStyle,
});
