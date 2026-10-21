import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { isValidEmail } from "../../domain/rules";
import { useI18n } from "../../i18n";
import { api, ApiError } from "../../services/api";
import { useApp } from "../../state/app";
import { ErrorText, FormLabel, NavHeader, PageTitle, PrimaryButton } from "../../ui/components";
import { LineInput } from "../../ui/inputs";
import { Screen } from "../../ui/Screen";
import { Txt } from "../../ui/Txt";

/** Email change: the new address is verified with a code before the account is updated. */
export default function ChangeEmail() {
  const { t, lang } = useI18n();
  const { updateUser, toast } = useApp();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = async () => {
    if (!isValidEmail(email)) return setError(t("invalidEmail"));
    setBusy(true); setError("");
    try {
      await api.requestEmailChange(email.trim(), lang);
      setStep("code");
    } catch (e) {
      setError(e instanceof ApiError && e.code === "email_taken" ? t("emailTaken") : e instanceof ApiError && e.code === "rate_limited" ? t("rateLimited") : t("networkError"));
    } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError("");
    try {
      const r = await api.verifyEmailChange(email.trim(), code);
      await updateUser(r.user);
      toast(t("emailUpdated"));
      router.back();
    } catch (e) {
      const c = e instanceof ApiError ? e.code : "network";
      setError(c === "expired_code" ? t("expiredCode") : c === "too_many_attempts" ? t("tooManyAttempts") : c === "invalid_code" ? t("wrongCode") : c === "email_taken" ? t("emailTaken") : t("networkError"));
    } finally { setBusy(false); }
  };
  return (
    <Screen keyboard>
      <NavHeader title={t("account")} backA11y={t("back")} onBack={() => router.back()} />
      <PageTitle>{step === "email" ? t("changeEmail") : t("checkMail")}</PageTitle>
      {step === "email" ? (
        <View>
          <FormLabel>{t("newEmail")}</FormLabel>
          <LineInput value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" accessibilityLabel={t("newEmail")} />
          {error ? <ErrorText>{error}</ErrorText> : null}
          <PrimaryButton label={busy ? t("sending") : t("sendCode")} onPress={request} disabled={busy} />
        </View>
      ) : (
        <View>
          <Txt size={19} color="#717b8c">{t("codeSentTo") + "\n" + email}</Txt>
          <View style={{ marginTop: 24 }}>
            <LineInput value={code} onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" accessibilityLabel={t("codeA11y")} placeholder="______" />
          </View>
          {error ? <ErrorText>{error}</ErrorText> : null}
          <PrimaryButton label={busy ? t("verifying") : t("save")} onPress={verify} disabled={busy || code.length !== 6} />
        </View>
      )}
    </Screen>
  );
}
