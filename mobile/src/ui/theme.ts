import { useWindowDimensions } from "react-native";

/** Values from mock/styles.css. Names follow the CSS custom properties. */
export const C = {
  paper: "#ffffff",
  ink: "#111210",
  muted: "#717687",
  line: "#d8dbe1",
  soft: "#f1f2f4",
  photoInk: "#d8dbe1", // --photo-ink: var(--line)
  fab: "#10110f",
  primary: "#131512",
  play: "#151714",
  waveBar: "#14192a",
  error: "#8c3636",
  backdrop: "#00000055", // #0005
  sheetHandle: "#d1d5dd",
  switchOff: "#d7dade",
  switchOn: "#151614",
  toast: "#222222",
  placeholder: "#9b9fa8",
  focus: "#5b6070",
} as const;

/** Tinos Regular, the mock's DaySerif (mock/assets/Tinos-Regular.ttf). Same file on both platforms. */
export const SERIF = "Tinos-Regular";

/**
 * `@media (max-width: 390px)` of the mock: on a 390 pt/dp wide screen the narrow values apply,
 * exactly like the HTML rendered at that viewport.
 */
export function useMetrics() {
  const { width } = useWindowDimensions();
  const narrow = width <= 390;
  return {
    width,
    narrow,
    pad: narrow ? 20 : 24,
    emptyH1: narrow ? 33 : 35,
    sheetPad: narrow ? 20 : 24,
    fabRight: narrow ? 20 : 24,
  };
}
