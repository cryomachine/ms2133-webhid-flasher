// Deterministic protocol-shaped test data, generated only in memory.
// This is not vendor firmware and must never be offered as a flashable image.
export const CONTAINER_SIZE = 0x18034;

export function fixContainerChecksums(image) {
  if (image.length !== CONTAINER_SIZE) throw new RangeError('Synthetic container length');
  let header = 0, payload = 0;
  for (let i = 2; i < 12; i++) header += image[i];
  for (let i = 16; i < 48; i++) header += image[i];
  for (let i = 0x30; i < 0x18030; i++) payload += image[i];
  image.set([header >>> 8 & 255, header & 255, payload >>> 8 & 255, payload & 255], 0x18030);
  return image;
}

export function makeSyntheticContainer(seed = 0x23) {
  const image = Uint8Array.from({ length: CONTAINER_SIZE }, (_, i) =>
    (i * 37 + (i >>> 8) * 13 + seed) & 255);
  image.set([0x3c, 0xc3, 0x80, 0, 0xff, 0xff, 0xff, 0xff,
    0x80, 0, 0, 2, 0x1a, 7, 0x10, 0x16]);
  return fixContainerChecksums(image);
}

export function makeSyntheticFlash(size = 0x80000, seed = 0x23) {
  if (size < CONTAINER_SIZE) throw new RangeError('Synthetic flash length');
  const image = Uint8Array.from({ length: size }, (_, i) =>
    (i * 17 + (i >>> 8) + seed) & 255);
  image.set(makeSyntheticContainer(seed));
  return image;
}
