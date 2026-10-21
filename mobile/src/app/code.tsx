import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Keyboard, TextInput, View } from "react-native";
import { useI18n } from "../i18n";
import { api, ApiError } from "../services/api";
import { useApp } from "../state/app";
import { ErrorText, NavHeader, PrimaryButton, QuietAction } from "../ui/components";
import { Screen } from "../ui/Screen";
import { SERIF } from "../ui/theme";
import { Txt } from "../ui/Txt";

/** Code step: 6 digits, paste/autofill, resend after the server's wait, change email. */
export default function Code() {
  const params = useLocalSearchParams<{ email: string; resendAfter?: string; next?: string }>();
  const email = params.email ?? "";
  const { t, lang } = useI18n();
  const { signIn } = useApp();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resendAt, setResendAt] = useState(() => Date.now() + Number(params.resendAfter ?? 0) * 1000);
  const [now, setNow] = useState(Date.now());
  const input = useRef<TextInput>(null);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const wait = Math.ceil((resendAt - now) / 1000);

  const verify = async (value = code) => {
    if (value.length !== 6) return setError(t("incompleteCode"));
    setBusy(true);
    setError("");
    try {
      const r = await api.verifyCode(email, value);
      Keyboard.dismiss();
      await signIn({ token: r.token, user: r.user });
      router.dismissAll?.();
      router.replace("/day/today");
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "network";
      setError(code === "expired_code" ? t("expiredCode") : code === "too_many_attempts" ? t("tooManyAttempts") : code === "invalid_code" ? t("wrongCode") : t("networkError"));
    } finally {
      setBusy(false);
    }
  };
  const resend = async () => {
    try {
      const r = await api.requestCode(email, lang);
      setResendAt(Date.now() + r.resendAfter * 1000);
      setError("");
      setCode("");
    } catch (e) {
      if (e instanceof ApiError && e.code === "rate_limited") setResendAt(Date.now() + (e.retryAfter ?? 42) * 1000);
      else setError(t("networkError"));
    }
  };

  return (
    <Screen keyboard>
      <NavHeader title={t("brand")} backA11y={t("back")} onBack={() => router.back()} />
      <Txt size={40} lh={1.1} ls={-0.7} align="center" style={{ maxWidth: 290, alignSelf: "center" }} accessibilityRole="header">
        {t("checkMail")}
      </Txt>
      <Txt size={19} color="#717b8c" align="center" style={{ marginTop: 26, marginBottom: 14 }}>
        {t("codeSentTo") + "\n" + email}
      </Txt>
      <QuietAction label={t("changeEmail")} align="center" onPress={() => router.back()} />
      <TextInput
        ref={input}
        testID="code-input"
        value={code}
        onChangeText={(v) => {
          const digits = v.replace(/\D/g, "").slice(0, 6);
          setCode(digits);
          if (error) setError("");
          if (digits.length === 6) verify(digits);
        }}
        placeholder="______"
        placeholderTextColor="#757575"
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={6}
        accessibilityLabel={t("codeA11y")}
        selectionColor="#111210"
        style={{
          fontFamily: SERIF, fontSize: 32, letterSpacing: 17, textAlign: "center", marginTop: 49, height: 64.2,
          paddingLeft: 17, paddingVertical: 0, borderBottomWidth: 1, borderBottomColor: "#a1a8b5", color: "#000000", includeFontPadding: false,
        }}
      />
      <Txt size={16} color="#8a92a1" align="center" style={{ marginTop: 24 }}>
        {t("expiresIn")}
      </Txt>
      {error ? <ErrorText>{error}</ErrorText> : null}
      <PrimaryButton label={busy ? t("verifying") : t("enter")} onPress={() => verify()} disabled={code.length !== 6 || busy} marginTop={error ? 18 : 30} />
      <QuietAction label={wait > 0 ? t("resendIn", { s: wait }) : t("resend")} align="center" disabled={wait > 0} onPress={resend} />
      <Txt size={16} color="#8a92a1" align="center" style={{ marginTop: 24 }}>
        {t("checkSpam")}
      </Txt>
      <View />
    </Screen>
  );
}
