import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Image, View } from "react-native";
import { isValidEmail } from "../domain/rules";
import { useI18n } from "../i18n";
import { api, ApiError } from "../services/api";
import { loadPrefs } from "../services/storage";
import { Btn, ErrorText, FormLabel, PrimaryButton } from "../ui/components";
import { LineInput } from "../ui/inputs";
import { Screen } from "../ui/Screen";
import { C } from "../ui/theme";
import { Txt } from "../ui/Txt";

/** Email step: same path for sign-up and sign-in. Never reveals whether an account exists. */
export default function Access() {
  const params = useLocalSearchParams<{ email?: string }>();
  const { t, lang } = useI18n();
  const [email, setEmail] = useState(params.email ?? "");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!params.email) loadPrefs().then((p) => p.lastEmail && setEmail((e) => e || p.lastEmail!));
  }, [params.email]);

  const submit = async () => {
    const value = email.trim();
    if (!isValidEmail(value)) return setError(t("invalidEmail"));
    setError("");
    setSending(true);
    try {
      const r = await api.requestCode(value, lang);
      router.push({ pathname: "/code", params: { email: value, resendAfter: String(r.resendAfter) } });
    } catch (e) {
      if (e instanceof ApiError && e.code === "rate_limited") router.push({ pathname: "/code", params: { email: value, resendAfter: String(e.retryAfter ?? 42) } });
      else if (e instanceof ApiError && e.code === "invalid_email") setError(t("invalidEmail"));
      else setError(t("networkError"));
    } finally {
      setSending(false);
    }
  };

  return (
    <Screen keyboard>
      <View style={{ height: 53, borderBottomWidth: 1, borderBottomColor: C.line, alignItems: "center", justifyContent: "center", marginBottom: 38 }}>
        <Txt size={34} lh={1} ls={-1.2} accessibilityRole="header">{t("brand")}</Txt>
      </View>
      <Txt size={40} lh={1.1} ls={-0.7} align="center" style={{ maxWidth: 290, alignSelf: "center", marginBottom: 20 }}>
        {t("authTitle1") + "\n" + t("authTitle2")}
      </Txt>
      <Image source={require("../../assets/images/twig.png")} style={{ width: 200, height: 170, alignSelf: "center" }} resizeMode="contain" accessibilityIgnoresInvertColors accessible={false} />
      <Txt size={20} lh={1.4} color="#737b8b" align="center" style={{ marginTop: 18 }}>
        {t("enterWithEmail")}
      </Txt>
      <View style={{ marginTop: 30 }}>
        <FormLabel>{t("email")}</FormLabel>
        <LineInput
          testID="email-input"
          value={email}
          onChangeText={(v) => { setEmail(v); if (error) setError(""); }}
          placeholder="hola@ejemplo.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          autoComplete="email"
          textContentType="emailAddress"
          accessibilityLabel={t("email")}
          returnKeyType="send"
          onSubmitEditing={submit}
        />
      </View>
      {error ? <View style={{ marginTop: 12 }}><ErrorText>{error}</ErrorText></View> : null}
      <PrimaryButton label={sending ? t("sending") : t("sendCode")} onPress={submit} disabled={sending} marginTop={error ? 18 : 30} />
      <View style={{ flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: C.line, marginTop: 32, paddingTop: 14 }}>
        <Btn label={t("privacy")} onPress={() => router.push({ pathname: "/legal", params: { kind: "privacy" } })} style={{ paddingVertical: 1, paddingHorizontal: 6, marginLeft: 0 }}>
          <Txt size={15} color="#9a9fab">{t("privacy")}</Txt>
        </Btn>
        <Btn label={t("terms")} onPress={() => router.push({ pathname: "/legal", params: { kind: "terms" } })} style={{ paddingVertical: 1, paddingHorizontal: 6 }}>
          <Txt size={15} color="#9a9fab">{t("terms")}</Txt>
        </Btn>
      </View>
    </Screen>
  );
}
