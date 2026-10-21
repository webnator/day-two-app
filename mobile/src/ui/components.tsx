import { useState, type ReactNode } from "react";
import {
  Pressable, StyleSheet, View, type PressableProps, type StyleProp, type TextLayoutLine, type ViewStyle, Text,
} from "react-native";
import { Icon, ProfileIcon, type IconName } from "./Icon";
import { C, SERIF, useMetrics } from "./theme";
import { Txt, useLineHeight } from "./Txt";
import { accessibleColor, useHighContrast } from "./contrast";
import { baselineOf } from "./metrics";

// ---------------------------------------------------------------- Button base

export function Btn({
  label,
  style,
  children,
  disabled,
  role = "button",
  ...rest
}: Omit<PressableProps, "style" | "children"> & { label: string; style?: StyleProp<ViewStyle>; children?: ReactNode; role?: "button" | "link" | "switch" | "tab" }) {
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={4}
      style={({ pressed }) => [style, disabled ? { opacity: 0.45 } : pressed ? { opacity: 0.6 } : null]}
      {...rest}
    >
      {children}
    </Pressable>
  );
}

// ---------------------------------------------------------------- Underlined text (text-underline-offset: 4px)

/**
 * CSS `text-decoration: underline; text-underline-offset: 4px; thickness 1px` with skip-ink.
 * The line is drawn 4 px under the alphabetic baseline of every rendered line; a white halo
 * around glyphs interrupts it where descenders cross, like the browser's skip-ink.
 */
export function Underlined({
  children, size, lh: lhProp, color, align = "center", offset = 4, style,
}: { children: string; size: number; lh?: number; color: string; align?: "center" | "left"; offset?: number | "auto"; style?: any }) {
  const [lines, setLines] = useState<TextLayoutLine[]>([]);
  const inherited = useLineHeight();
  const lh = lhProp ?? inherited;
  const lineH = size * lh;
  const base = baselineOf(size, lineH);
  const off = offset === "auto" ? 0.106 * size + 0.5 : offset; // Tinos underlinePosition ≈ 0.106 em
  return (
    <View style={style}>
      {lines.map((l, i) => (
        <View key={i} pointerEvents="none" style={{ position: "absolute", left: l.x, width: l.width, top: i * lineH + base + off, height: 1, backgroundColor: color }} />
      ))}
      <Txt
        size={size}
        lh={lh}
        color={color}
        align={align}
        onTextLayout={(e) => setLines(e.nativeEvent.lines)}
        style={{ textShadowColor: "#ffffff", textShadowRadius: 2, textShadowOffset: { width: 0, height: 0 } }}
      >
        {children}
      </Txt>
    </View>
  );
}

// ---------------------------------------------------------------- Headers

/** `.app-header`: profile/gear · "day two" · calendar, 53 px with a fine separator. */
export function AppHeader({ onProfile, onCalendar, marginBottom = 24, t }: { onProfile?: () => void; onCalendar?: () => void; marginBottom?: number; t: (k: any) => string }) {
  return (
    <View style={[s.appHeader, { marginBottom }]}>
      {onProfile ? (
        <Btn label={t("profileSettings")} onPress={onProfile} style={[s.headerBtn, { marginLeft: -9, height: 45 }]}>
          <ProfileIcon />
        </Btn>
      ) : (
        <View style={{ width: 44 }} />
      )}
      <Txt size={34} lh={1} ls={-1.2} align="center" style={{ flex: 1 }} accessibilityRole="header">
        {t("brand")}
      </Txt>
      {onCalendar ? (
        <Btn label={t("openCalendar")} onPress={onCalendar} style={[s.headerBtn, { marginRight: -9, height: 44 }]}>
          <Icon name="calendar" />
        </Btn>
      ) : (
        <View style={{ width: 44 }} />
      )}
    </View>
  );
}

/** `.nav-header` with a back button (icon + optional label), centered title and right side. */
export function NavHeader({
  title = "", backLabel = "", backA11y, onBack, right, marginBottom = 28,
}: { title?: string; backLabel?: string; backA11y: string; onBack: () => void; right?: ReactNode; marginBottom?: number }) {
  return (
    <View style={[s.navHeader, { marginBottom }]}>
      <Btn label={backLabel || backA11y} onPress={onBack} style={s.back}>
        <Icon name="back" w={25} />
        {backLabel ? <Txt>{backLabel}</Txt> : null}
      </Btn>
      <Txt align="center" style={{ flex: 1 }} numberOfLines={1} accessibilityRole="header">
        {title}
      </Txt>
      <View style={s.navSide}>{right}</View>
    </View>
  );
}

/** Editor header: two text actions with the date between (`.nav-header > button:not(.back)`). */
export function TextNavHeader({ left, leftA11y, onLeft, title, right, rightA11y, onRight, marginBottom = 18, rightDisabled }: {
  left: string; leftA11y: string; onLeft: () => void; title: string; right?: string; rightA11y?: string; onRight?: () => void; marginBottom?: number; rightDisabled?: boolean;
}) {
  return (
    <View style={[s.navHeader, { marginBottom }]}>
      <Btn label={leftA11y} onPress={onLeft} style={s.navTextBtn}>
        <Txt>{left}</Txt>
      </Btn>
      <Txt align="center" style={{ flex: 1 }} numberOfLines={1} accessibilityRole="header">
        {title}
      </Txt>
      {right ? (
        <Btn label={rightA11y || right} onPress={onRight} style={s.navTextBtn} disabled={rightDisabled}>
          <Txt>{right}</Txt>
        </Btn>
      ) : (
        <View style={{ width: 44 }} />
      )}
    </View>
  );
}

/** Generic text button inside `.nav-side` (UA padding 1px 6px). */
export function NavTextButton({ label, a11y, onPress }: { label: string; a11y?: string; onPress: () => void }) {
  return (
    <Btn label={a11y || label} onPress={onPress} style={{ paddingVertical: 1, paddingHorizontal: 6, minHeight: 44, justifyContent: "center" }}>
      <Txt>{label}</Txt>
    </Btn>
  );
}

export function NavIconButton({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return (
    <Btn label={label} onPress={onPress} style={[s.iconButton, { marginRight: -10 }]}>
      <Icon name={icon} />
    </Btn>
  );
}

// ---------------------------------------------------------------- Rows

/** `.list-row`: optional icon, label (+ small), value and chevron. */
export function ListRow({
  title, sub, icon, value, onPress, a11y, variant = "page", chevron = true, right,
}: {
  title: string; sub?: string; icon?: IconName; value?: string; onPress?: () => void; a11y?: string;
  variant?: "page" | "settings" | "sheet" | "tags"; chevron?: boolean; right?: ReactNode;
}) {
  const v = rowVariants[variant];
  const content = (
    <>
      {icon ? <Icon name={icon} w={24} /> : null}
      <View style={{ flex: 1 }}>
        <Txt size={v.size} lh={v.lh}>
          {title}
        </Txt>
        {sub ? (
          <Txt size={16} lh={v.lh} color="#858d9d" style={{ marginTop: 4 }}>
            {sub}
          </Txt>
        ) : null}
      </View>
      {value ? (
        <Txt size={18} lh={v.lh} color="#858d9d">
          {value}
        </Txt>
      ) : null}
      {right}
      {chevron && onPress ? <Icon name="next" w={18} h={24} /> : null}
    </>
  );
  const style = [s.listRow, { minHeight: v.minHeight, paddingVertical: v.pv }];
  return onPress ? (
    <Btn label={a11y || title} onPress={onPress} style={style}>
      {content}
    </Btn>
  ) : (
    <View style={style}>{content}</View>
  );
}
const rowVariants = {
  page: { minHeight: 75, size: 22, lh: 1.35, pv: 17 },
  settings: { minHeight: 82, size: 22, lh: 1.35, pv: 17 },
  sheet: { minHeight: 58, size: 20, lh: 1.4, pv: 17 },
  tags: { minHeight: 55, size: 22, lh: 1.35, pv: 8 },
};

// ---------------------------------------------------------------- Photo placeholder

export function PhotoPlaceholder({ label, a11y, onPress }: { label: string; a11y: string; onPress: () => void }) {
  const ink = accessibleColor(C.photoInk, useHighContrast());
  return (
    <Btn label={a11y} onPress={onPress} style={s.placeholder}>
      <View style={[s.corner, { borderColor: ink, top: 0, left: 6, borderTopWidth: 1, borderLeftWidth: 1 }]} />
      <View style={[s.corner, { borderColor: ink, top: 0, right: 6, borderTopWidth: 1, borderRightWidth: 1 }]} />
      <View style={[s.corner, { borderColor: ink, bottom: 0, left: 6, borderBottomWidth: 1, borderLeftWidth: 1 }]} />
      <View style={[s.corner, { borderColor: ink, bottom: 0, right: 6, borderBottomWidth: 1, borderRightWidth: 1 }]} />
      <Icon name="camera" color={ink} />
      <Txt size={17} color={ink} style={{ marginTop: 1 }}>
        {label}
      </Txt>
    </Btn>
  );
}

// ---------------------------------------------------------------- Buttons

export function PrimaryButton({ label, a11y, onPress, disabled, marginTop = 30, testID }: { label: string; a11y?: string; onPress: () => void; disabled?: boolean; marginTop?: number; testID?: string }) {
  return (
    <Btn label={a11y || label} onPress={onPress} disabled={disabled} testID={testID} style={[s.primary, { marginTop }]}>
      <Txt size={22} color="#ffffff" align="center">
        {label}
      </Txt>
    </Btn>
  );
}
export function SecondaryButton({ label, a11y, onPress, disabled }: { label: string; a11y?: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Btn label={a11y || label} onPress={onPress} disabled={disabled} style={s.secondary}>
      <Txt size={20} align="center">
        {label}
      </Txt>
    </Btn>
  );
}
/** `.quiet-action`: underlined muted text button, 18px, min-height 44. */
export function QuietAction({ label, a11y, onPress, disabled, align = "left", style }: { label: string; a11y?: string; onPress: () => void; disabled?: boolean; align?: "left" | "center"; style?: StyleProp<ViewStyle> }) {
  return (
    <Btn label={a11y || label} onPress={onPress} disabled={disabled} style={[s.quiet, align === "center" && { alignSelf: "center" }, style]}>
      <Underlined size={18} color="#596273" align={align}>
        {label}
      </Underlined>
    </Btn>
  );
}
/** `.text-link` (19px, #505766). */
export function TextLink({ label, a11y, onPress }: { label: string; a11y?: string; onPress: () => void }) {
  return (
    <Btn label={a11y || label} onPress={onPress} style={s.textLink}>
      <Underlined size={19} color="#505766">
        {label}
      </Underlined>
    </Btn>
  );
}

export function Switch({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Btn label={label} role="switch" accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={[s.switch, { backgroundColor: value ? C.switchOn : C.switchOff }]}>
      <View style={[s.knob, { transform: [{ translateX: value ? 19 : 0 }] }]} />
    </Btn>
  );
}

// ---------------------------------------------------------------- Text blocks

export function PageTitle({ children, mb = 26 }: { children: string; mb?: number }) {
  return (
    <Txt size={37} lh={1.08} ls={-0.8} style={{ marginBottom: mb }} accessibilityRole="header">
      {children}
    </Txt>
  );
}
export function BodyMuted({ children, size = 18, style, align }: { children: ReactNode; size?: number; style?: any; align?: "center" | "left" }) {
  return (
    <Txt size={size} lh={1.4} color="#737b8b" style={style} align={align}>
      {children}
    </Txt>
  );
}
export function SectionTitle({ children, size = 24, mt = 27, mb = 13 }: { children: string; size?: number; mt?: number; mb?: number }) {
  return (
    <Txt size={size} lh={1.2} style={{ marginTop: mt, marginBottom: mb }} accessibilityRole="header">
      {children}
    </Txt>
  );
}
export function FormLabel({ children }: { children: string }) {
  return (
    <Txt size={16} color="#808798" style={{ marginBottom: 8 }}>
      {children}
    </Txt>
  );
}
export function InputNote({ children, style }: { children: string; style?: any }) {
  return (
    <Txt size={15} color="#89909e" style={[{ marginTop: 15 }, style]}>
      {children}
    </Txt>
  );
}
export function ErrorText({ children }: { children: string }) {
  return (
    <Txt size={16} lh={1.35} color={C.error} style={{ marginVertical: 12 }} accessibilityRole="alert" accessibilityLiveRegion="polite">
      {children}
    </Txt>
  );
}

export function Tabs({ items, active, onChange }: { items: { key: string; label: string }[]; active: string; onChange: (k: string) => void }) {
  return (
    <View style={s.tabs} accessibilityRole="tablist">
      {items.map((it) => (
        <Btn
          key={it.key}
          label={it.label}
          role="tab"
          accessibilityState={{ selected: it.key === active }}
          onPress={() => onChange(it.key)}
          style={[s.tab, { borderBottomColor: it.key === active ? "#111111" : "transparent" }]}
        >
          <Txt align="center" color={it.key === active ? "#111111" : "#8a8e9c"}>
            {it.label}
          </Txt>
        </Btn>
      ))}
    </View>
  );
}

export function Separator({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: 1, backgroundColor: C.line }, style]} />;
}

export const s = StyleSheet.create({
  appHeader: { minHeight: 53, borderBottomWidth: 1, borderBottomColor: C.line, flexDirection: "row", alignItems: "center" },
  headerBtn: { width: 53, alignItems: "center", justifyContent: "center" },
  navHeader: { minHeight: 55, flexDirection: "row", alignItems: "center", justifyContent: "space-between", columnGap: 6 },
  back: { flexDirection: "row", alignItems: "center", marginLeft: -10, minHeight: 44, paddingHorizontal: 5 },
  navSide: { flexDirection: "row", alignItems: "center", columnGap: 6 },
  navTextBtn: { minHeight: 44, paddingVertical: 4, justifyContent: "center" },
  iconButton: { minWidth: 44, minHeight: 44, padding: 8, alignItems: "center", justifyContent: "center" },
  listRow: { flexDirection: "row", alignItems: "center", columnGap: 13, borderBottomWidth: 1, borderBottomColor: C.line, width: "100%" },
  placeholder: { width: "100%", height: 62, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  corner: { position: "absolute", width: 12, height: 12, borderColor: C.photoInk },
  primary: { width: "100%", paddingVertical: 13, paddingHorizontal: 16, borderRadius: 8, backgroundColor: C.primary, minHeight: 52, justifyContent: "center" },
  secondary: { width: "100%", padding: 12, minHeight: 48, justifyContent: "center" },
  quiet: { paddingVertical: 8, minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
  textLink: { paddingVertical: 5, minHeight: 40, justifyContent: "center", width: "100%" },
  switch: { width: 45, height: 26, padding: 3, borderRadius: 30, justifyContent: "center" },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: "#ffffff" },
  tabs: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: C.line, marginBottom: 24 },
  tab: { flex: 1, paddingVertical: 12, paddingHorizontal: 4, borderBottomWidth: 1.5 },
});

export { Text, SERIF };
