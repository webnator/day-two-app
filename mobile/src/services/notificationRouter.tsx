import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { useApp } from "../state/app";

/** Opening a reminder brings the person to today (photo reminder: the day where the photo goes). */
export function NotificationRouter() {
  const { session } = useApp();
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      if (!session) return;
      const data = r.notification.request.content.data as { kind?: string; day?: string };
      router.navigate({ pathname: "/day/[day]", params: { day: data.kind === "photo" && data.day ? data.day : "today" } });
    });
    return () => sub.remove();
  }, [session]);
  return null;
}
