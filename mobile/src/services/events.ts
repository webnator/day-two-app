// Tiny change bus: repositories mutate, screens re-read.
type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;
export function emitChange() {
  version++;
  listeners.forEach((l) => l());
}
export function subscribe(l: Listener) {
  listeners.add(l);
  return () => void listeners.delete(l);
}
export const getVersion = () => version;
