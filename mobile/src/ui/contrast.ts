import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform } from "react-native";

/** WCAG relative luminance contrast against white. */
export function contrastOnWhite(hex: string): number {
  const h = hex.replace("#", "").slice(0, 6);
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return 1.05 / (l + 0.05);
}

/**
 * The design keeps the mock's pale greys by default (pixel fidelity). When the person turns on the
 * system's increased-contrast setting, any grey below 4.5:1 on white is replaced by one that passes.
 */
export function accessibleColor(hex: string, high: boolean): string {
  if (!high || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  return contrastOnWhite(hex) >= 4.5 ? hex : "#5c6373"; // 6.2:1, same cool grey family
}

let current = false;
const listeners = new Set<(v: boolean) => void>();
const check = Platform.OS === "ios" ? AccessibilityInfo.isDarkerSystemColorsEnabled : AccessibilityInfo.isHighTextContrastEnabled;
check?.().then((v) => {
  current = !!v;
  listeners.forEach((l) => l(current));
}).catch(() => undefined);
AccessibilityInfo.addEventListener(Platform.OS === "ios" ? "darkerSystemColorsChanged" : ("highTextContrastChanged" as any), (v: boolean) => {
  current = !!v;
  listeners.forEach((l) => l(current));
});

export function useHighContrast(): boolean {
  const [v, setV] = useState(current);
  useEffect(() => {
    listeners.add(setV);
    return () => void listeners.delete(setV);
  }, []);
  return v;
}
