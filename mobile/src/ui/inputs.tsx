import { forwardRef } from "react";
import { Platform, TextInput, type TextInputProps } from "react-native";
import { C, SERIF } from "./theme";
import { useLineHeight } from "./Txt";

/** `.text-input`: bottom border #b6bcc6, padding 10 0, 22px serif. Height = 10 + 22×1.35 + 10 + 1. */
export const LineInput = forwardRef<TextInput, TextInputProps & { size?: number; borderColor?: string }>(function LineInput(
  { size = 22, borderColor = "#b6bcc6", style, ...rest },
  ref,
) {
  const lh = size * useLineHeight();
  return (
    <TextInput
      ref={ref}
      placeholderTextColor="#757575"
      selectionColor={C.ink}
      cursorColor={C.ink}
      maxFontSizeMultiplier={2}
      {...rest}
      style={[
        {
          fontFamily: SERIF,
          fontSize: size,
          color: "#000000",
          height: lh + 20 + 1,
          paddingVertical: 0,
          paddingHorizontal: 0,
          borderBottomWidth: 1,
          borderBottomColor: borderColor,
          textAlignVertical: "center",
          includeFontPadding: false,
        },
        Platform.OS === "android" ? { paddingTop: 0, paddingBottom: 0 } : null,
        style,
      ]}
    />
  );
});
