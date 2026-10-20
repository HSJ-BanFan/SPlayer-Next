import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsAutoMixFeatures } from "@splayer/audio-engine";

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  status: vi.fn(),
  model: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  rm: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@main/utils/logger", () => ({ playerLog: { info: mocks.log } }));
vi.mock("@main/services/engine", () => ({ getEngine: () => ({ analyzeAutoMix: mocks.analyze }) }));
vi.mock("node:fs/promises", () => {
  const fs = {
    stat: mocks.stat,
    mkdir: mocks.mkdir,
    mkdtemp: mocks.mkdtemp,
    readFile: mocks.read,
    writeFile: mocks.write,
    rm: mocks.rm,
  };
  return { default: fs, ...fs };
});
vi.mock("@main/utils/paths", () => ({ automixCacheDir: "cache" }));
vi.mock("./components", () => ({ getAutoMixComponentStatus: mocks.status }));
vi.mock("./inference", () => ({
  runAutoMixModel: mocks.model,
  runAutoMixTask: (signal: AbortSignal, task: () => Promise<unknown>) => {
    signal.throwIfAborted();
    return task();
  },
}));

const features: JsAutoMixFeatures = {
  startSeconds: 0,
  endSeconds: 30,
  firstAudibleSeconds: 0,
  lastAudibleSeconds: 30,
  mel: new Float32Array(1500 * 128),
  levels: new Float32Array(300).fill(0.1),
  chroma: new Float32Array(300 * 12),
};

describe("按需生成有限音乐档案", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.status.mockResolvedValue({
      models: ["beat", "demucs", "runtime"].map((id) => ({ id, state: "ready" })),
    });
    mocks.stat.mockResolvedValue({ size: 1, mtimeMs: 1, ctimeMs: 1 });
    mocks.mkdtemp.mockResolvedValue("cache/beats-test");
    mocks.analyze.mockResolvedValue(features);
    mocks.read.mockResolvedValue(Buffer.alloc(1500 * 8));
    mocks.model.mockResolvedValue([{ frames: 1500 }]);
  });

  it("缺少运行时时不导出模型输入，也不启动推理", async () => {
    mocks.status.mockResolvedValue({ models: [{ id: "beat", state: "ready" }] });
    const { analyzeAutoMixTracks } = await import("./analysisHost");
    expect(
      await analyzeAutoMixTracks(
        [{ source: "a.flac", startMs: 0, tail: true }],
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining("组件未就绪：runtime"));
  });

  it("只缓存紧凑档案，重复请求不再读取频谱或启动模型", async () => {
    const { analyzeAutoMixTracks } = await import("./analysisHost");
    const tracks = [{ source: "a.flac", startMs: 0, tail: true }];
    const signal = new AbortController().signal;
    const result = await analyzeAutoMixTracks(tracks, signal);
    expect(result?.[0]).not.toHaveProperty("mel");
    expect(await analyzeAutoMixTracks(tracks, signal)).toEqual(result);
    expect(mocks.analyze).toHaveBeenCalledOnce();
    expect(mocks.model).toHaveBeenCalledOnce();
    expect(mocks.rm).toHaveBeenCalledWith("cache/beats-test", { recursive: true, force: true });
  });

  it("首尾相同预测采用不同选段，缓存仍只保留对应的紧凑档案", async () => {
    const scores = new Float32Array(3000).fill(-100);
    for (const base of [0, 18_000]) {
      for (let time = base; time <= (base ? 24_000 : 12_000); time += 500)
        scores[(time / 20) * 2] = 4;
    }
    mocks.read.mockResolvedValue(Buffer.from(scores.buffer));
    const { analyzeAutoMixTracks } = await import("./analysisHost");
    const profiles = await analyzeAutoMixTracks(
      [
        { source: "a.flac", startMs: 0, tail: true },
        { source: "b.flac", startMs: 0, tail: false },
      ],
      new AbortController().signal,
    );
    expect(profiles?.[0].gridStartMs).toBe(18_000);
    expect(profiles?.[1].gridStartMs).toBe(0);
    expect(mocks.model).toHaveBeenCalledOnce();
  });

  it.each(["文件", "范围"])("%s 变化时只分析未命中的窗口", async (change) => {
    const { analyzeAutoMixTracks } = await import("./analysisHost");
    const tracks = [
      { source: "a.flac", startMs: 0, tail: true },
      { source: "b.flac", startMs: 0, tail: false },
    ];
    const signal = new AbortController().signal;
    await analyzeAutoMixTracks(tracks, signal);
    if (change === "文件") mocks.stat.mockResolvedValueOnce({ size: 2, mtimeMs: 2, ctimeMs: 2 });
    else tracks[0] = { ...tracks[0], startMs: 1000 };
    await analyzeAutoMixTracks(tracks, signal);
    expect(mocks.analyze).toHaveBeenCalledTimes(3);
    expect(mocks.analyze).toHaveBeenLastCalledWith(
      "a.flac",
      tracks[0].startMs / 1000,
      undefined,
      true,
    );
    expect(mocks.model.mock.calls[1][1]).toHaveLength(1);
  });

  it("没有完整模型上下文的短音频保留正常切歌", async () => {
    mocks.analyze.mockResolvedValue({ ...features, mel: new Float32Array(500 * 128) });
    const { analyzeAutoMixTracks } = await import("./analysisHost");
    expect(
      await analyzeAutoMixTracks(
        [{ source: "short.wav", startMs: 0, tail: true }],
        new AbortController().signal,
      ),
    ).toBeNull();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledOnce();
  });

  it("导出期间取消后不启动模型，并释放临时文件", async () => {
    const signal = new AbortController();
    mocks.analyze.mockImplementation(() => {
      signal.abort();
      return features;
    });
    const { analyzeAutoMixTracks } = await import("./analysisHost");
    await expect(
      analyzeAutoMixTracks([{ source: "a.flac", startMs: 0, tail: true }], signal.signal),
    ).rejects.toThrow();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledOnce();
  });
});
