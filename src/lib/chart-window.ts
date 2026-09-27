export function chartWindow(total: number, visibleCount: number, requestedOffset: number) {
  const rightGap = Math.max(4, Math.round(visibleCount * 0.12));
  const minOffset = -(visibleCount - rightGap - 1);
  const maxOffset = Math.max(0, total + rightGap - 1);
  const offset = Math.max(minOffset, Math.min(maxOffset, requestedOffset));
  const startIndex = total - visibleCount + rightGap - offset;
  const firstIndex = Math.max(0, startIndex);
  const endIndex = Math.min(total, startIndex + visibleCount);
  return { offset, minOffset, maxOffset, firstIndex, endIndex, leftSlots: firstIndex - startIndex };
}
