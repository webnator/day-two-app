import { forwardRef, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View, useWindowDimensions, type ScrollViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMetrics } from "./theme";

/**
 * `.screen` + `.page`: white, native safe areas (no drawn system bars), side padding 24/20,
 * bottom padding 30 + 26 (126 + 26 on day pages, leaving room for the +).
 */
export const Screen = forwardRef<ScrollView, { children: ReactNode; day?: boolean; floating?: ReactNode; keyboard?: boolean; bottom?: number } & ScrollViewProps>(
  function Screen({ children, day = false, floating, keyboard = false, bottom, ...rest }, ref) {
    const insets = useSafeAreaInsets();
    const m = useMetrics();
    // Changing the system text size while the app is open: re-create the line boxes.
    const { fontScale } = useWindowDimensions();
    const body = (
      <ScrollView
        key={fontScale}
        ref={ref}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: m.pad, paddingBottom: (bottom ?? (day ? 126 : 30)) + 26, flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets={keyboard && Platform.OS === "ios"}
        {...rest}
      >
        {children}
      </ScrollView>
    );
    return (
      <View style={{ flex: 1, backgroundColor: "#fff", paddingTop: insets.top }}>
        {keyboard && Platform.OS === "android" ? <KeyboardAvoidingView style={{ flex: 1 }} behavior="height">{body}</KeyboardAvoidingView> : body}
        {floating}
      </View>
    );
  },
);
