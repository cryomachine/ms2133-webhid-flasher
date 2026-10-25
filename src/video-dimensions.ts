/**
 * Normalize the dimensions exposed by AVFoundation-backed UVC capture.
 *
 * The MS2133 416 x 416 mode is delivered by macOS as a 416-pixel image with
 * 448-byte CoreVideo row strides. Some capture paths surface that stride as
 * one or both decoded dimensions (448 x 416, 416 x 448, or 448 x 448), even
 * though the requested UVC mode is still 416 x 416. Keep the aliases scoped
 * to the requested 416 mode so a genuine 448-pixel camera mode is never
 * silently relabeled.
 */
export function isAvFoundation416Alias(width: number, height: number): boolean {
  // Depending on the AVFoundation bridge, the 448-byte stride can replace
  // either one or both dimensions in the metadata exposed to the caller.
  // Accept only the 416/448 combinations; this remains scoped to an explicit
  // 416 request by matchesRequestedDimensions/normalizeReportedDimensions.
  return [width, height].every(value => value === 416 || value === 448)
    && (width === 448 || height === 448);
}

export function matchesRequestedDimensions(
  width: number | undefined,
  height: number | undefined,
  requested: number,
): boolean {
  if (width == null || height == null) return false;
  return (width === requested && height === requested)
    || (requested === 416 && isAvFoundation416Alias(width, height));
}

export function normalizeReportedDimensions(
  width: number | undefined,
  height: number | undefined,
  requested: number | null | undefined,
): { width: number | undefined; height: number | undefined } {
  if (requested === 416 && width != null && height != null && isAvFoundation416Alias(width, height)) {
    return { width: 416, height: 416 };
  }
  return { width, height };
}
