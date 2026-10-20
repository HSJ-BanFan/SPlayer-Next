import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dir: `${process.cwd()}/node_modules/.cache/automix-components-test`,
  fetch: vi.fn(),
  broadcast: vi.fn(),
  extract: vi.fn(),
}));

const body = Buffer.from("automix-test-runtime");
vi.mock("@main/utils/paths", () => ({
  get automixDir() {
    return mocks.dir;
  },
}));
vi.mock("@main/utils/broadcast", () => ({ broadcast: mocks.broadcast }));
vi.mock("@main/utils/logger", () => ({ playerLog: { warn: vi.fn() } }));
vi.mock("electron", () => ({ net: { fetch: mocks.fetch } }));
vi.mock("./runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime")>()),
  extractAutoMixPackage: mocks.extract,
}));
vi.mock("./assets", async () => {
  const { createHash } = await import("node:crypto");
  const actual = await vi.importActual<typeof import("./assets")>("./assets");
  return {
    ...actual,
    AUTOMIX_COMPONENTS: {
      runtime: { file: "runtime.zip", bytes: 0, sha256: "", url: null, contents: [] },
      demucs: {
        file: "demucs.zip",
        bytes: 20,
        sha256: createHash("sha256").update("automix-test-runtime").digest("hex"),
        url: "https://example.test/origin/demucs",
        contents: [
          {
            file: "model.bin",
            bytes: 20,
            sha256: createHash("sha256").update("automix-test-runtime").digest("hex"),
          },
        ],
      },
      beat: {
        file: "beat.zip",
        bytes: 20,
        sha256: createHash("sha256").update("automix-test-runtime").digest("hex"),
        url: "https://example.test/runtime",
        contents: [
          {
            file: "model.bin",
            bytes: 20,
            sha256: createHash("sha256").update("automix-test-runtime").digest("hex"),
          },
        ],
      },
    },
  };
});

describe("AutoMix 组件完整性与手动下载", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.extract.mockImplementation(async (_file: string, directory: string) => {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "model.bin"), body);
    });
    await mkdir(mocks.dir, { recursive: true });
  });
  afterEach(async () => {
    expect(
      path
        .resolve(mocks.dir)
        .startsWith(path.resolve(process.cwd(), "node_modules", ".cache") + path.sep),
    ).toBe(true);
    await rm(mocks.dir, { recursive: true, force: true });
  });

  it("导入与重复导入 Rust 包都更新实际文件，并逐文件核验", async () => {
    const { AUTOMIX_RUNTIME_VERSION, AUTOMIX_RUNTIME_FILES, AUTOMIX_WORKER } =
      await import("./assets");
    const installed = path.join(mocks.dir, "runtime");
    await mkdir(installed, { recursive: true });
    await writeFile(path.join(installed, ".version"), "python-v2");
    await writeFile(path.join(installed, "python.exe"), body);
    const service = await import("./components");
    expect((await service.getAutoMixComponentStatus()).models[2].state).toBe("missing");
    let runtimeBody = body;
    mocks.extract.mockImplementation(async (_file: string, directory: string) => {
      await Promise.all(
        AUTOMIX_RUNTIME_FILES.map((file) => writeFile(path.join(directory, file), runtimeBody)),
      );
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify({
          version: AUTOMIX_RUNTIME_VERSION,
          platform: process.platform,
          arch: process.arch,
          contents: AUTOMIX_RUNTIME_FILES.map((file) => ({
            file,
            bytes: runtimeBody.length,
            sha256: createHash("sha256").update(runtimeBody).digest("hex"),
          })),
        }),
      );
    });
    const input = path.join(mocks.dir, "local-rust.zip");
    await writeFile(input, body);
    expect((await service.installAutoMixComponents("runtime", input)).models[2].state).toBe(
      "ready",
    );
    await expect(readFile(path.join(installed, "python.exe"))).rejects.toThrow();
    expect((await service.getAutoMixComponentStatus()).models[2].state).toBe("ready");
    runtimeBody = Buffer.from("updated-independent-rust-worker");
    await writeFile(input, runtimeBody);
    expect((await service.installAutoMixComponents("runtime", input)).models[2].state).toBe(
      "ready",
    );
    expect(await readFile(path.join(installed, AUTOMIX_WORKER))).toEqual(runtimeBody);
    expect((await service.getAutoMixComponentStatus()).models[2].state).toBe("ready");
    await writeFile(
      path.join(installed, AUTOMIX_RUNTIME_FILES[1]),
      Buffer.alloc(runtimeBody.length),
    );
    vi.resetModules();
    const restarted = await import("./components");
    expect((await restarted.getAutoMixComponentStatus()).models[2].state).toBe("missing");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("损坏下载不会成为可执行组件，临时文件被清理", async () => {
    mocks.fetch.mockResolvedValue(new Response("broken"));
    const service = await import("./components");
    expect((await service.installAutoMixComponents("beat")).state).toBe("error");
    await expect(readFile(path.join(mocks.dir, "beat.zip"))).rejects.toThrow();
    await expect(readFile(path.join(mocks.dir, "beat.zip.part"))).rejects.toThrow();
  });

  it("手动下载校验成功后才发布就绪状态，重复点击共用任务", async () => {
    mocks.fetch.mockResolvedValue(new Response(body));
    const service = await import("./components");
    expect((await service.getAutoMixComponentStatus()).state).toBe("missing");
    expect(mocks.fetch).not.toHaveBeenCalled();
    const first = service.installAutoMixComponents("beat");
    expect(service.installAutoMixComponents("beat")).toBe(first);
    expect((await first).models.find((item) => item.id === "beat")?.state).toBe("ready");
    expect(await readFile(path.join(mocks.dir, "beat.zip"))).toEqual(body);
    expect((await service.getAutoMixComponentStatus()).state).toBe("missing");
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("取消可中断下载，不会把未完成组件发布为可用", async () => {
    mocks.fetch.mockImplementation(
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
    );
    const service = await import("./components");
    const result = service.installAutoMixComponents("beat");
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    service.cancelAutoMixDownload();
    expect((await result).state).toBe("missing");
    await expect(readFile(path.join(mocks.dir, "beat.zip"))).rejects.toThrow();
  });

  it("组件包校验通过但模型内容不符时，不发布安装目录", async () => {
    mocks.fetch.mockResolvedValue(new Response(body));
    mocks.extract.mockImplementationOnce(async (_file: string, directory: string) => {
      await writeFile(path.join(directory, "model.bin"), Buffer.alloc(body.length));
    });
    const service = await import("./components");
    const result = await service.installAutoMixComponents("beat");
    expect(result.models[0].state).toBe("error");
    await expect(readFile(path.join(mocks.dir, "beat", ".version"))).rejects.toThrow();
    await expect(readFile(path.join(mocks.dir, "beat.part", "model.bin"))).rejects.toThrow();
  });

  it("逐模型下载，不会隐式下载其他模型或把不完整环境发布为就绪", async () => {
    mocks.fetch.mockImplementation(() => Promise.resolve(new Response(body)));
    const service = await import("./components");
    await service.installAutoMixComponents("beat");
    expect(mocks.fetch.mock.calls.map((call) => call[0])).toEqual(["https://example.test/runtime"]);
    const status = await service.installAutoMixComponents("demucs");
    expect(status.state).toBe("missing");
    expect(status.models.filter((item) => item.state === "ready").map((item) => item.id)).toEqual([
      "beat",
      "demucs",
    ]);
    expect(await readFile(path.join(mocks.dir, "beat.zip"))).toEqual(body);
    await expect(service.installAutoMixComponents("invalid" as never)).rejects.toThrow();
  });

  it("导入兼容文件时不联网，按文件内容识别并保留用户的原文件", async () => {
    const input = path.join(mocks.dir, "user-renamed-model.zip");
    await writeFile(input, body);
    const service = await import("./components");
    const result = await service.installAutoMixComponents("beat", input);
    expect(result.models.find((item) => item.id === "beat")?.state).toBe("ready");
    expect(await readFile(input)).toEqual(body);
    expect(await readFile(path.join(mocks.dir, "beat.zip"))).toEqual(body);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("未发布的组件不发起下载，仍支持本地校验导入", async () => {
    const { AUTOMIX_COMPONENTS } = await import("./assets");
    const asset = AUTOMIX_COMPONENTS.beat!;
    const url = asset.url;
    asset.url = null;
    try {
      const input = path.join(mocks.dir, "local.zip");
      await writeFile(input, body);
      const service = await import("./components");
      expect((await service.getAutoMixComponentStatus()).models[0].downloadAvailable).toBe(false);
      const unavailable = await service.installAutoMixComponents("beat");
      expect(unavailable.models[0].error).toContain("暂未发布");
      const imported = await service.installAutoMixComponents("beat", input);
      expect(imported.models[0].state).toBe("ready");
      expect(mocks.fetch).not.toHaveBeenCalled();
    } finally {
      asset.url = url;
    }
  });

  it("拒绝同长度的错误模型，失败导入不会覆盖已安装的文件", async () => {
    await writeFile(path.join(mocks.dir, "beat.zip"), body);
    const input = path.join(mocks.dir, "wrong.zip");
    await writeFile(input, Buffer.alloc(body.length));
    const service = await import("./components");
    await service.installAutoMixComponents("beat");
    const result = await service.installAutoMixComponents("beat", input);
    expect(result.models.find((item) => item.id === "beat")?.error).toContain("校验失败");
    expect(result.models.find((item) => item.id === "beat")?.state).toBe("ready");
    expect(await readFile(path.join(mocks.dir, "beat.zip"))).toEqual(body);
    await expect(readFile(path.join(mocks.dir, "beat.zip.import"))).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("常规查询复用校验结果，重启后识别已损坏的模型", async () => {
    const service = await import("./components");
    await writeFile(path.join(mocks.dir, "beat.zip"), body);
    await service.installAutoMixComponents("beat");
    await writeFile(path.join(mocks.dir, "beat", "model.bin"), Buffer.alloc(body.length));
    expect((await service.getAutoMixComponentStatus()).models[0].state).toBe("ready");
    vi.resetModules();
    const restarted = await import("./components");
    expect((await restarted.getAutoMixComponentStatus()).models[0].state).toBe("missing");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("保留的分块文件通过 HTTP Range 续传，完成后核验整个文件", async () => {
    await writeFile(path.join(mocks.dir, "beat.zip.part"), body.subarray(0, 8));
    mocks.fetch.mockResolvedValue(
      new Response(body.subarray(8), {
        status: 206,
        headers: { "content-range": `bytes 8-${body.length - 1}/${body.length}` },
      }),
    );
    const service = await import("./components");
    const result = await service.installAutoMixComponents("beat");
    expect(result.models[0].state).toBe("ready");
    expect(mocks.fetch.mock.calls[0][1].headers).toEqual({ Range: "bytes=8-" });
    expect(await readFile(path.join(mocks.dir, "beat.zip"))).toEqual(body);
  });

  it("服务端忽略续传范围时从头写入，不拼接重复的文件头", async () => {
    await writeFile(path.join(mocks.dir, "demucs.zip.part"), body.subarray(0, 8));
    mocks.fetch.mockResolvedValue(new Response(body));
    const service = await import("./components");
    const result = await service.installAutoMixComponents("demucs");
    expect(result.models.find((item) => item.id === "demucs")?.state).toBe("ready");
    expect(await readFile(path.join(mocks.dir, "demucs.zip"))).toEqual(body);
  });
});
