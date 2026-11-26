/** macOS window sizes are logical points. Other platforms keep physical-pixel sizing. */
export function compactPetLayout(builtin: boolean, scalePercent: number, displayScale: number) {
  const scale = scalePercent / 100
  const factor = scale / displayScale
  const width = (builtin ? 180 : 150) * factor
  const height = (builtin ? 137 : 106) * factor
  const left = 6 * factor
  return { scale, left, width, height, windowWidth: width + left, windowHeight: height + factor }
}
