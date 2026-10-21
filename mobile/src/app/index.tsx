import { Redirect } from "expo-router";
import { useApp } from "../state/app";

export default function Index() {
  const { session } = useApp();
  return <Redirect href={session ? "/day/today" : "/access"} />;
}
