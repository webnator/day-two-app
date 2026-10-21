// DEVELOPMENT ONLY: raw RN text rendering grid (no corrections) to calibrate against Chromium.
import { useLocalSearchParams } from "expo-router";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import rows from "../../dev/calib-rows.json";
import { SERIF } from "../../ui/theme";

export default function Calib() {
  const { page } = useLocalSearchParams<{ page: string }>();
  const p = Number(page ?? 0);
  const insets = useSafeAreaInsets();
  const H = 760;
  return (
    <View style={{ flex: 1, backgroundColor: "#fff", paddingTop: insets.top }}>
      {rows
        .filter((r) => r.y >= p * H && r.y + r.L <= (p + 1) * H)
        .map((r, i) => (
          <Text key={i} style={{ position: "absolute", left: 10, top: insets.top + r.y - p * H, fontFamily: SERIF, fontSize: r.size, lineHeight: r.size * r.lh, color: "#000", includeFontPadding: false }}>
            {r.t}
          </Text>
        ))}
    </View>
  );
}
