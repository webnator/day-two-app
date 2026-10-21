import DateTimePicker from "@react-native-community/datetimepicker";
import { useState } from "react";
import { Platform, View } from "react-native";
import { Btn, FormLabel } from "./components";
import { Icon } from "./Icon";
import { C } from "./theme";
import { Txt } from "./Txt";

/** `.check-option`: 18 px box (accent #151515) + 20 px label, padding 10 0. */
export function CheckOption({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Btn label={label} role="button" accessibilityState={{ checked }} onPress={() => onChange(!checked)} style={{ flexDirection: "row", alignItems: "center", columnGap: 12, paddingVertical: 10 }}>
      <View style={{ width: 18, height: 18, borderRadius: 3, borderWidth: checked ? 0 : 1.5, borderColor: "#767676", backgroundColor: checked ? "#151515" : "#ffffff", alignItems: "center", justifyContent: "center" }}>
        {checked ? <Icon name="check" w={14} color="#ffffff" stroke={2.6} /> : null}
      </View>
      <Txt size={20}>{label}</Txt>
    </Btn>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * `.date-input` (19 px serif, bottom line) opening the native picker.
 * mode "date" → value "YYYY-MM-DD" (or ""), mode "time" → "HH:MM".
 */
export function PickerField({
  label, value, onChange, mode, max, placeholder = "dd/mm/aaaa", clearable = false, clearLabel = "Quitar", mt = 24, mb = 0,
}: { label: string; value: string; onChange: (v: string) => void; mode: "date" | "time"; max?: string; placeholder?: string; clearable?: boolean; clearLabel?: string; mt?: number; mb?: number }) {
  const [open, setOpen] = useState(false);
  const toDate = () => {
    if (mode === "date") {
      if (!value) return max ? new Date(max + "T12:00:00") : new Date();
      return new Date(value + "T12:00:00");
    }
    const [h, m] = (value || "19:00").split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  };
  const display = mode === "date" ? (value ? value.split("-").reverse().join("/") : placeholder) : value || "--:--";
  return (
    <View style={{ marginTop: mt, marginBottom: mb }}>
      <FormLabel>{label}</FormLabel>
      <Btn label={`${label}: ${display}`} onPress={() => setOpen((o) => !o)} style={{ borderBottomWidth: 1, borderBottomColor: C.line, height: 49.59, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Txt size={19} color={value ? C.ink : "#757575"}>{display}</Txt>
        {clearable && value ? (
          <Btn label={clearLabel} onPress={() => onChange("")} style={{ paddingHorizontal: 6 }}>
            <Icon name="close" w={18} />
          </Btn>
        ) : (
          <Icon name={mode === "date" ? "calendar" : "clock"} w={18} />
        )}
      </Btn>
      {open ? (
        <DateTimePicker
          value={toDate()}
          mode={mode}
          is24Hour
          locale="es-ES"
          maximumDate={mode === "date" && max ? new Date(max + "T23:59:59") : undefined}
          display={Platform.OS === "ios" ? (mode === "date" ? "inline" : "spinner") : "default"}
          onChange={(e, d) => {
            if (Platform.OS === "android") setOpen(false);
            if (e.type === "dismissed" || !d) return;
            onChange(mode === "date" ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`);
          }}
          themeVariant="light"
          accentColor={C.ink}
        />
      ) : null}
    </View>
  );
}
