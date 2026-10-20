import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoMixPlan, AutoMixProfile } from "@shared/types/automix";

const mocks = vi.hoisted(() => ({
  export: vi.fn(),
  separate: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
}));
vi.mock("node:fs/promises", () => {
  const fs = { stat: mocks.stat, mkdir: mocks.mkdir, mkdtemp: mocks.mkdtemp, rm: mocks.rm };
  return { ...fs, default: fs };
});
vi.mock("@main/utils/paths", () => ({ automixCacheDir: "cache" }));
vi.mock("@main/services/engine", () => ({
  getEngine: () => ({ exportAutoMixWindow: mocks.export }),
}));
vi.mock("./inference", () => ({
  runAutoMixTask: (signal: AbortSignal, task: () => Promise<unknown>) => {
    signal.throwIfAborted();
    return task();
  },
  runAutoMixModel: mocks.separate,
}));

const profile: AutoMixProfile = {
  startMs: 0,
  endMs: 40_000,
  firstAudibleMs: 0,
  lastAudibleMs: 40_000,
  bodyEndMs: 40_000,
  levels: Array(400).fill(0.1),
  chroma: Array(4800).fill(0),
  boundaries: [],
  beats: [],
  downbeats: [],
  periodMs: 500,
  stability: 1,
  gridStartMs: 0,
  gridEndMs: 40_000,
};
const plan: AutoMixPlan = {
  outStartMs: 30_000,
  inStartMs: 0,
  durationMs: 6000,
  outgoingRate: 1,
  strategy: "phrase",
  levelRatio: 1,
  envelopes: Array.from({ length: 8 }, () => ({ startMs: 0, endMs: 6000 })),
};
const tracks = ["a.flac", "b.flac"].map((source, index) => ({
  source,
  startMs: 0,
  tail: index === 0,
}));

describe("有限交接窗口的声部增强", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.stat.mockResolvedValue({ size: 1, mtimeMs: 1, ctimeMs: 1 });
    mocks.rm.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.mkdtemp.mockResolvedValue("cache/mix-test");
    mocks.separate.mockResolvedValue(
      [0, 1].map(() => ({
        frames: 400_000,
        structure: {
          vocals: Array(90).fill(0),
        },
      })),
    );
  });

  it("只导出已选交接及前后上下文，缓存复用不重复分离或持有原始 PCM", async () => {
    const { enhanceAutoMixPlan } = await import("./enhancement");
    const signal = new AbortController().signal;
    const result = await enhanceAutoMixPlan(plan, tracks, [profile, profile], signal);
    expect(mocks.export).toHaveBeenNthCalledWith(
      1,
      "a.flac",
      28.5,
      37.5,
      false,
      expect.stringContaining("0.pcm"),
    );
    expect(mocks.export).toHaveBeenNthCalledWith(
      2,
      "b.flac",
      0,
      7.5,
      false,
      expect.stringContaining("1.pcm"),
    );
    expect(result.stems?.outgoing.startMs).toBe(28_500);
    expect(mocks.rm).toHaveBeenCalledWith(expect.stringContaining("0.pcm"), { force: true });
    expect(await enhanceAutoMixPlan(plan, tracks, [profile, profile], signal)).toBe(result);
    expect(mocks.separate).toHaveBeenCalledOnce();
  });

  it("导出途中取消后不启动模型，临时窗口被清理", async () => {
    const { enhanceAutoMixPlan } = await import("./enhancement");
    const controller = new AbortController();
    mocks.export.mockImplementationOnce(() => controller.abort());
    await expect(
      enhanceAutoMixPlan(plan, tracks, [profile, profile], controller.signal),
    ).rejects.toThrow();
    expect(mocks.separate).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledWith("cache/mix-test", { recursive: true, force: true });
  });

  it("持续人声仍按音频交接，只调整人声包络并保留已选背景与倍率", async () => {
    const { enhanceAutoMixPlan } = await import("./enhancement");
    mocks.separate.mockResolvedValue(
      [0, 1].map(() => ({
        frames: 400_000,
        structure: {
          vocals: Array(90).fill(0.1),
        },
      })),
    );
    const result = await enhanceAutoMixPlan(
      { ...plan, outgoingRate: 1.02 },
      tracks,
      [profile, profile],
      new AbortController().signal,
    );
    expect(result.stems).toBeDefined();
    expect(result.outgoingRate).toBe(1.02);
    expect(result.outStartMs).toBe(plan.outStartMs);
    expect(result.inStartMs).toBe(plan.inStartMs);
    expect(result.durationMs).toBe(plan.durationMs);
    expect(result.envelopes[6].endMs).toBeLessThanOrEqual(1500);
    for (const index of [0, 1, 3, 4, 5, 7])
      expect(result.envelopes[index]).toEqual(plan.envelopes[index]);
    for (const span of result.envelopes) {
      expect(span.startMs).toBeGreaterThanOrEqual(0);
      expect(span.endMs).toBeGreaterThan(span.startMs);
      expect(span.endMs).toBeLessThanOrEqual(result.durationMs);
    }
  });
});
