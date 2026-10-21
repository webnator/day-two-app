import { router } from "expo-router";
import { useI18n } from "../i18n";
import { PermissionDenied, pickImage, Unavailable } from "../services/media";
import { useApp } from "../state/app";
import { ListRow } from "./components";
import { Sheet } from "./Sheet";

/** "Foto del día": camera or library, then a preview where the photo is saved explicitly. */
export function PhotoSourceSheet({ visible, day, onClose, title }: { visible: boolean; day: string; onClose: () => void; title?: string }) {
  const { t } = useI18n();
  const { toast } = useApp();
  const pick = async (source: "camera" | "library") => {
    onClose();
    // iOS can't present the system picker while the sheet's modal is still being dismissed.
    await new Promise((r) => setTimeout(r, 450));
    try {
      const p = await pickImage(source);
      if (!p) return; // cancelled: nothing changes
      router.push({ pathname: "/photo-preview", params: { day, uri: p.uri, ext: p.ext, mime: p.mime, w: String(p.width ?? ""), h: String(p.height ?? "") } });
    } catch (e) {
      if (e instanceof PermissionDenied || e instanceof Unavailable) toast(t("cameraDenied"));
      else toast(t("photoFailed"));
    }
  };
  return (
    <Sheet visible={visible} title={title ?? t("dayPhoto")} onClose={onClose} closeLabel={t("close")}>
      <ListRow variant="sheet" icon="camera" title={t("takePhoto")} onPress={() => pick("camera")} />
      <ListRow variant="sheet" icon="image" title={t("fromGallery")} onPress={() => pick("library")} />
    </Sheet>
  );
}
