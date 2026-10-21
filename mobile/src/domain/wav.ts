/**
 * Repairs the RIFF/WAVE header of a recording that was interrupted before the recorder
 * finalized it (app killed, crash). Audio frames already on disk are kept; only the size
 * fields are rewritten from the real file length. Returns null when it is not a WAV file.
 */
export function repairWavHeader(header: Uint8Array, fileSize: number): Uint8Array | null {
  const ascii = (o: number) => String.fromCharCode(header[o], header[o + 1], header[o + 2], header[o + 3]);
  if (header.length < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const out = new Uint8Array(header);
  const outView = new DataView(out.buffer);
  outView.setUint32(4, fileSize - 8, true);
  let o = 12;
  while (o + 8 <= header.length) {
    const id = ascii(o);
    const size = view.getUint32(o + 4, true);
    if (id === "data") {
      outView.setUint32(o + 4, Math.max(0, fileSize - (o + 8)), true);
      return out;
    }
    o += 8 + size + (size % 2);
  }
  return null;
}

/** Duration in ms of a PCM WAV given its header and size. */
export function wavDurationMs(header: Uint8Array, fileSize: number): number | null {
  const ascii = (o: number) => String.fromCharCode(header[o], header[o + 1], header[o + 2], header[o + 3]);
  if (header.length < 44 || ascii(0) !== "RIFF") return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  let o = 12, byteRate = 0;
  while (o + 8 <= header.length) {
    const id = ascii(o), size = view.getUint32(o + 4, true);
    if (id === "fmt ") byteRate = view.getUint32(o + 16, true);
    if (id === "data") return byteRate ? Math.round(((fileSize - (o + 8)) / byteRate) * 1000) : null;
    o += 8 + size + (size % 2);
  }
  return null;
}
