// DEVELOPMENT ONLY: opens a mock scenario with the mock's data for visual comparison (tools/visual).
import { router, useLocalSearchParams } from "expo-router";
import { dataFor, routes } from "../../dev/scenarios";
import { useEffect } from "react";
import { View } from "react-native";
import { fixtureClock, seedFixture, seedFor } from "../../dev/fixtures";
import { useApp } from "../../state/app";

export default function Visual() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const { enterFixture } = useApp();
  useEffect(() => {
    if (!__DEV__) {
      router.replace("/");
      return;
    }
    let alive = true;
    (async () => {
      let j;
      try {
        j = await seedFixture(dataFor[name] ?? seedFor(name));
      } catch (e) {
        console.log("FIXTURE FAILED", name, String(e), (e as any)?.cause?.message ?? "", (e as Error)?.stack?.split("\n").slice(0, 6).join(" | "));
        return;
      }
      if (!alive) return;
      enterFixture(name, j, fixtureClock);
      router.replace(routes[name] ?? "/day/today");
    })();
    return () => {
      alive = false;
    };
  }, [name, enterFixture]);
  return <View style={{ flex: 1, backgroundColor: "#fff" }} />;
}
