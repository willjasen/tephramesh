import { describe, expect, it } from "vitest";
import { formatMetricsPoint, METRICS_MAX_BYTES } from "../src/metrics";

describe("metrics", () => {
  it("formats compact Influx line protocol", () => {
    expect(formatMetricsPoint({
      measurement: "tephramesh_peer",
      tags: { peer: "A,B", instance: "local" },
      fields: { connected: 1 },
      timestamp: 1_234,
    })).toBe("tephramesh_peer,instance=local,peer=A\\,B connected=1i 1234000000\n");
  });

  it("keeps the retention limit bounded", () => {
    expect(METRICS_MAX_BYTES).toBeLessThanOrEqual(256 * 1024);
  });
});
