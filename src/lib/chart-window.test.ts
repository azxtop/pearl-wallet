import { describe, expect, it } from "vitest";
import { chartWindow } from "./chart-window";

describe("chart window boundaries", () => {
  it("keeps the newest candle visible at the left edge", () => {
    const view = chartWindow(300, 80, -1000);
    expect(view.endIndex - view.firstIndex).toBe(1);
    expect(view.firstIndex).toBe(299);
    expect(view.leftSlots).toBe(0);
  });

  it("keeps the oldest candle visible at the right edge", () => {
    const view = chartWindow(300, 80, 1000);
    expect(view.firstIndex).toBe(0);
    expect(view.endIndex).toBe(1);
    expect(view.leftSlots).toBe(79);
  });

  it("places a short history near the latest side without moving it off screen", () => {
    const view = chartWindow(3, 80, 0);
    expect(view.endIndex - view.firstIndex).toBe(3);
    expect(view.leftSlots).toBe(67);
  });
});
