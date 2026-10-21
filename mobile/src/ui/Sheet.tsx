import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, Dimensions, Easing, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { Btn, PrimaryButton, SecondaryButton } from "./components";
import { Icon } from "./Icon";
import { C, useMetrics } from "./theme";
import { LineHeight, Txt } from "./Txt";

/**
 * `.sheet` of the mock: bottom sheet, radius 20, padding 13/24|20/34, handle, heading 27px,
 * backdrop #0005 over the whole screen, entry animation 0.22 s cubic-bezier(.16,1,.3,1).
 */
export function Sheet({
  visible, title, onClose, children, confirm = false, closeLabel = "Cerrar",
}: { visible: boolean; title: string; onClose: () => void; children: ReactNode; confirm?: boolean; closeLabel?: string }) {
  const m = useMetrics();
  const { height } = useWindowDimensions();
  const anim = useRef(new Animated.Value(0)).current;
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", (e) =>
      // Android reports the keyboard height without the navigation bar, but this full-screen modal draws under it:
      // measure from the keyboard's top edge instead.
      setKb(Platform.OS === "android" ? Math.max(e.endCoordinates.height, Dimensions.get("screen").height - e.endCoordinates.screenY) : e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setKb(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  useEffect(() => {
    if (!visible) return;
    anim.setValue(0);
    AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (reduce) anim.setValue(1);
      else Animated.timing(anim, { toValue: 1, duration: 220, easing: Easing.bezier(0.16, 1, 0.3, 1), useNativeDriver: true }).start();
    });
  }, [visible, anim]);
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <View style={st.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={closeLabel} importantForAccessibility="no" accessible={false} />
        <Animated.View
          accessibilityViewIsModal
          accessibilityLabel={title}
          style={[
            st.sheet,
            { paddingHorizontal: m.sheetPad, maxHeight: (height - kb) * 0.92, marginBottom: kb },
            { opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }), transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }] },
          ]}
        >
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingTop: 13, paddingBottom: kb ? 16 : 34 }} showsVerticalScrollIndicator={false}>
            <View style={st.handle} />
            <View style={[st.heading, confirm && { justifyContent: "center" }]}>
              <Txt size={27} lh={1.12} ls={-0.5} accessibilityRole="header" align={confirm ? "center" : "left"} style={[{ flexShrink: 1 }, confirm && { marginTop: 8, marginBottom: 9 }]}>
                {title}
              </Txt>
              {confirm ? null : (
                <Btn label={closeLabel} onPress={onClose} style={st.close}>
                  <Icon name="close" w={20} h={24} />
                </Btn>
              )}
            </View>
            <LineHeight.Provider value={1.4}>{children}</LineHeight.Provider>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

/** Sheet paragraph (`.sheet p`: 18px, #717989, margin-bottom 15; confirm sheets use #303439 centered). */
export function SheetText({ children, confirm = false, style }: { children: ReactNode; confirm?: boolean; style?: any }) {
  return (
    <Txt size={18} lh={1.4} color={confirm ? "#303439" : "#717989"} align={confirm ? "center" : "left"} style={[{ marginBottom: 15 }, style]}>
      {children}
    </Txt>
  );
}

export function ConfirmSheet({
  visible, title, text, action, onConfirm, onClose, cancelLabel,
}: { visible: boolean; title: string; text: string; action: string; onConfirm: () => void; onClose: () => void; cancelLabel: string }) {
  return (
    <Sheet visible={visible} title={title} onClose={onClose} confirm>
      <SheetText confirm>{text}</SheetText>
      {/* p margin-bottom 15 collapses with the button's 22 */}
      <PrimaryButton label={action} onPress={onConfirm} marginTop={7} testID="confirm-action" />
      <SecondaryButton label={cancelLabel} onPress={onClose} />
    </Sheet>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: C.backdrop, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    width: "100%",
    shadowColor: "#000000",
    shadowOpacity: 0.03,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: -6 },
  },
  handle: { height: 4, width: 40, backgroundColor: C.sheetHandle, borderRadius: 10, alignSelf: "center", marginBottom: 21 },
  heading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", columnGap: 8, marginBottom: 16 },
  close: { minWidth: 40, minHeight: 40, marginRight: -10, paddingVertical: 1, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
});
