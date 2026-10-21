import { useEffect, useState } from "react";
import { View } from "react-native";
import { Txt } from "./Txt";

/**
 * `-webkit-line-clamp` as Chromium renders it: the text is cut at a word boundary and "…" is
 * appended, never in the middle of a word. A hidden copy measures candidates until they fit.
 */
export function Clamped({ text, lines, size, lh, color }: { text: string; lines: number; size: number; lh: number; color: string }) {
  const [shown, setShown] = useState(text);
  const [words, setWords] = useState<number | null>(null); // words kept in the current candidate
  useEffect(() => {
    setShown(text);
    setWords(null);
  }, [text]);
  const all = text.split(" ");
  return (
    <View>
      <Txt size={size} lh={lh} color={color} accessibilityLabel={text} numberOfLines={lines} ellipsizeMode="tail">
        {shown}
      </Txt>
      <View style={{ position: "absolute", left: 0, right: 0, top: 0, opacity: 0 }} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Txt
          size={size}
          lh={lh}
          color={color}
          onTextLayout={(e) => {
            const n = e.nativeEvent.lines.length;
            if (words === null) {
              if (n <= lines) return; // fits as is
              // Start from the words that fit in `lines` lines, then remove one at a time.
              const fit = e.nativeEvent.lines.slice(0, lines).map((l) => l.text).join("");
              const k = Math.max(1, fit.trim().split(/\s+/).length);
              setWords(k);
              setShown(all.slice(0, k).join(" ").replace(/[\s,.;:]+$/, "") + "…");
            } else if (n > lines && words > 1) {
              setWords(words - 1);
              setShown(all.slice(0, words - 1).join(" ").replace(/[\s,.;:]+$/, "") + "…");
            }
          }}
        >
          {words === null ? text : shown}
        </Txt>
      </View>
    </View>
  );
}
