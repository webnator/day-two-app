import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { AppProvider, useApp } from "../state/app";
import { NotificationRouter } from "../services/notificationRouter";
import { VisualControl } from "../dev/VisualControl";

SplashScreen.preventAutoHideAsync().catch(() => undefined);

function Toast() {
  const { toastMessage } = useApp();
  if (!toastMessage) return null;
  // `.toast`: bottom 31, sides 24, #222, radius 7, system font 14/1.4.
  return (
    <View pointerEvents="none" style={st.toast} accessibilityLiveRegion="polite" accessibilityRole="alert">
      <Text style={st.toastText}>{toastMessage}</Text>
    </View>
  );
}

function Root() {
  const { ready } = useApp();
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);
  if (!ready) return <View style={{ flex: 1, backgroundColor: "#fff" }} />;
  return (
    <View style={{ flex: 1, backgroundColor: "#fff" }}>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#fff" }, animation: "default" }} />
      <NotificationRouter />
      {__DEV__ ? <VisualControl /> : null}
      <Toast />
    </View>
  );
}

export default function Layout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppProvider>
          <Root />
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const st = StyleSheet.create({
  toast: {
    position: "absolute", bottom: 31, left: 24, right: 24, paddingVertical: 10, paddingHorizontal: 15, backgroundColor: "#222222", borderRadius: 7,
    shadowColor: "#111111", shadowOpacity: 0.13, shadowRadius: 9, shadowOffset: { width: 0, height: 4 }, elevation: 4,
  },
  toastText: { color: "#ffffff", fontSize: 14, lineHeight: 19.6, textAlign: "center" },
});
