import Svg, { Circle, G, Path } from "react-native-svg";
import { C } from "./theme";

/** Line icons copied verbatim from mock/app.js (`shapes`), 24×24 viewBox, stroke 1.45. */
export const shapes = {
  plus: "M12 5v14M5 12h14",
  back: "m15 4-8 8 8 8",
  next: "m9 4 8 8-8 8",
  close: "m6 6 12 12M6 18 18 6",
  calendar: "M5 3v4M19 3v4M3 9h18M4 5h16a1 1 0 0 1 1 1v15H3V6a1 1 0 0 1 1-1M9 13h6l-4 6",
  tag: "M3 13 13 3h7v7L10 20a2 2 0 0 1-3 0l-4-4a2 2 0 0 1 0-3M16 7h.01",
  heart: "M12 21 3 12C-3 4 7-1 12 6 17-1 27 4 21 12Z",
  cloud: "M6 19a5 5 0 0 1-1-10 7 7 0 0 1 13-2 6 6 0 0 1 0 12Z",
  link: "m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 2 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
  clip: "m8 16 8-8a3 3 0 0 0-4-4l-9 9a5 5 0 0 0 7 7L21 9M6 14l8-8",
  camera: "M3 7h4l2-3h6l2 3h4v13H3ZM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  image: "M3 3h18v18H3ZM3 16l6-6 6 6 3-3 3 3M16 7h.01",
  mic: "M8 4a4 4 0 0 1 8 0v7a4 4 0 0 1-8 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v4M8 23h8",
  pen: "m4 17-1 5 5-1L21 8l-4-4ZM14 7l4 4",
  play: "m8 4 13 8-13 8Z",
  pause: "M8 5v14M16 5v14",
  stop: "M5 5h14v14H5Z",
  search: "M17 17 22 22M19 10a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  filter: "M3 6h4M12 6h9M3 12h10M18 12h3M3 18h4M12 18h9M7 3h5v6H7ZM13 9h5v6h-5ZM7 15h5v6H7Z",
  check: "M20 5 9 16l-5-5",
  circlecheck: "M8 12l3 3 6-6M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  bell: "M4 18h16l-2-4V8a6 6 0 0 0-12 0v6ZM10 22h4",
  user: "M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0M3 22v-3a9 9 0 0 1 18 0v3Z",
  pin: "M12 22S4 13 4 8a8 8 0 0 1 16 0c0 5-8 14-8 14ZM15 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  globe: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M2 12h20M12 2c-6 7-6 13 0 20 6-7 6-13 0-20",
  data: "M5 2h14v20H5ZM8 7h8M8 11h8M8 15h4",
  export: "M12 2v14m-5-5 5 5 5-5M5 9H2v13h20V9h-3",
  logout: "M10 3H3v18h7M9 12h13m-5-5 5 5-5 5",
  trash: "M3 6h18M9 6V3h6v3M6 6v16h12V6M10 10v8M14 10v8",
  wifi: "m3 3 18 18M2 8q10-9 20 0M6 12q6-5 12 0M10 16q2-2 4 0M12 20h.01",
  video: "M3 6h13v12H3ZM16 10l5-3v10l-5-3",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2",
  // Weather variants used for the sky icon. "cloud" is the mock's; the rest follow the same stroke language.
  sun: "M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  partly: "M8 3v1.5M3.5 4.5l1 1M2 9h1.5M12.5 4.5l-1 1M5 10a3 3 0 0 1 5.7-1.3M8 20a4 4 0 0 1-.8-7.9 5.5 5.5 0 0 1 10.3-1.5A4.5 4.5 0 0 1 17.5 20Z",
  rain: "M6 15a5 5 0 0 1-1-10 7 7 0 0 1 13-2 6 6 0 0 1 0 12ZM8 18l-1 3M12 18l-1 3M16 18l-1 3",
  snow: "M6 15a5 5 0 0 1-1-10 7 7 0 0 1 13-2 6 6 0 0 1 0 12ZM8 19h.01M12 21h.01M16 19h.01",
  fog: "M6 13a5 5 0 0 1-1-9 7 7 0 0 1 13-1 6 6 0 0 1 0 10ZM4 17h16M6 21h12",
  storm: "M6 15a5 5 0 0 1-1-10 7 7 0 0 1 13-2 6 6 0 0 1 0 12ZM13 15l-3 4h4l-3 4",
} as const;
export type IconName = keyof typeof shapes | "more";

export function Icon({
  name,
  w = 24,
  h = w,
  color = C.ink,
  stroke = 1.45,
}: {
  name: IconName;
  w?: number;
  h?: number;
  color?: string;
  stroke?: number;
}) {
  if (name === "more")
    return (
      <Svg width={w} height={h} viewBox="0 0 24 24">
        <G fill={color}>
          <Circle cx={4} cy={12} r={1.8} />
          <Circle cx={12} cy={12} r={1.8} />
          <Circle cx={20} cy={12} r={1.8} />
        </G>
      </Svg>
    );
  const filled = name === "play" || name === "stop";
  return (
    <Svg width={w} height={h} viewBox="0 0 24 24">
      <Path
        d={shapes[name]}
        fill={filled ? color : "none"}
        stroke={filled ? "none" : color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Profile with the small gear, from mock/app.js `profile()` (viewBox 30). */
export function ProfileIcon({ size = 29, color = C.ink }: { size?: number; color?: string }) {
  const p = { fill: "none", stroke: color, strokeWidth: 1.45, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 30 30">
      <Circle cx={11} cy={8} r={5} {...p} />
      <Path d="M16 18c-7-7-14-1-14 10h15" {...p} />
      <Path d="m22 17 2-1 1 2 2 1v2l2 1-1 2-1 1v2l-2 1-2-1-2 1-1-2-2-1v-2l-1-2 2-1v-2Z" {...p} />
      <Circle cx={23} cy={23} r={2} {...p} />
    </Svg>
  );
}

export function weatherIcon(condition?: string | null): IconName {
  switch (condition) {
    case "clear":
      return "sun";
    case "partly":
      return "partly";
    case "rain":
    case "drizzle":
      return "rain";
    case "snow":
      return "snow";
    case "fog":
      return "fog";
    case "storm":
      return "storm";
    default:
      return "cloud";
  }
}
