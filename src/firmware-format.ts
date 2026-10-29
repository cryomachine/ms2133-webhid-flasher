const CONTAINER_SIZE_VALUE = 0x18034;
export const CONTAINER_SIZE = CONTAINER_SIZE_VALUE;

// Bytes 0..11 identify the MS2133 boot-container family. Bytes 12..15 are
// the firmware build/variant marker and differ between the stock and ROI
// images while using the same container layout and checksum rules.
const FAMILY_PREFIX = [0x3c, 0xc3, 0x80, 0, 0xff, 0xff, 0xff, 0xff, 0x80, 0, 0, 2];
const SUPPORTED_VARIANTS = new Set(["1a071016", "26102500"]);

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function firmwareContainerErrors(image: Uint8Array): string[] {
  const errors: string[] = [];
  if (image.length !== CONTAINER_SIZE_VALUE) {
    errors.push("固件必须为0x18034字节的MS2133容器；整片备份需先提取容器。");
    return errors;
  }
  if (FAMILY_PREFIX.some((byte, index) => image[index] !== byte)) {
    errors.push("固件容器家族头不符合当前支持的MS2133格式，未执行擦写。");
    return errors;
  }
  const variant = hex(image.slice(12, 16));
  if (!SUPPORTED_VARIANTS.has(variant)) {
    errors.push(`固件容器变体${variant.toUpperCase()}未列入当前支持的MS2133版本，未执行擦写。`);
    return errors;
  }
  let headerSum = 0, codeSum = 0;
  for (let index = 2; index < 12; index++) headerSum += image[index];
  for (let index = 16; index < 48; index++) headerSum += image[index];
  for (let index = 0x30; index < 0x18030; index++) codeSum += image[index];
  if ((headerSum & 0xffff) !== (image[0x18030] << 8 | image[0x18031]))
    errors.push("头部校验和不匹配。");
  if ((codeSum & 0xffff) !== (image[0x18032] << 8 | image[0x18033]))
    errors.push("固件载荷校验和不匹配。");
  return errors;
}
