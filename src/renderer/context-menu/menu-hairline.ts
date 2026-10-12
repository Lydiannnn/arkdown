export function normalizeMenuHairlineDpr(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1
}

export function getMenuHairlineThicknessCssPx(dpr: number): number {
  return 1 / normalizeMenuHairlineDpr(dpr)
}

export function getMenuHairlineOffsetCssPx(cssTop: number, dpr: number): number {
  const normalizedDpr = normalizeMenuHairlineDpr(dpr)
  return Math.round(cssTop * normalizedDpr) / normalizedDpr - cssTop
}
