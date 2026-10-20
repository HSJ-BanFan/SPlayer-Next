import { EventEmitter } from "node:events";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), quit: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, default: { spawn: mocks.spawn } }));
vi.mock("electron", () => ({ app: { isPackaged: false, once: mocks.quit } }));
vi.mock("@main/utils/paths", () => ({ automixDir: "models" }));
vi.mock("@main/utils/logger", () => ({ playerLog: { info: vi.fn() } }));
vi.mock("./assets", () => ({ AUTOMIX_WORKER: "automix-worker.exe" }));

/** 创建由测试控制退出时机的模型进程替身 */
const createChild = () =>
  Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
  });
const windows = [{ input: "a.mel", output: "a.beats" }];

describe("独立模型进程与串行任务", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  it("收到结果后仍等待进程关闭，文件和模型释放后才交出任务", async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);
    const { runAutoMixModel } = await import("./inference");
    const settled = vi.fn();
    const pending = runAutoMixModel("beat", windows, new AbortController().signal).then(settled);
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          windows: [{ frames: 1500 }],
          memoryMb: 100,
          seconds: 1,
          backend: "DirectML",
        }),
      ),
    );
    await flushPromises();
    expect(settled).not.toHaveBeenCalled();
    expect(mocks.spawn.mock.calls[0].slice(0, 2)).toEqual([
      path.join("models", "runtime", "automix-worker.exe"),
      [],
    ]);
    expect(JSON.parse(child.stdin.end.mock.calls[0][0]).model).toMatch(/beat-this\.onnx$/);
    child.emit("close", 0);
    await pending;
    expect(settled).toHaveBeenCalledExactlyOnceWith([{ frames: 1500 }]);
  });

  it("旧模型取消后等待关闭再启动下一模型", async () => {
    const firstChild = createChild();
    const secondChild = createChild();
    mocks.spawn.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const { runAutoMixTask, runAutoMixModel } = await import("./inference");
    const controller = new AbortController();
    const first = runAutoMixTask(controller.signal, () =>
      runAutoMixModel("beat", windows, controller.signal),
    ).catch((error: Error) => error);
    await flushPromises();
    controller.abort();
    const signal = new AbortController().signal;
    const second = runAutoMixTask(signal, () => runAutoMixModel("demucs", windows, signal));
    await flushPromises();
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(firstChild.kill).toHaveBeenCalledOnce();
    firstChild.emit("close", null);
    expect(await first).toBeInstanceOf(Error);
    await flushPromises();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    secondChild.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ windows: [{ frames: 100 }], memoryMb: 100, seconds: 1 })),
    );
    secondChild.emit("close", 0);
    expect(await second).toEqual([{ frames: 100 }]);
  });

  it("缺少运行程序时等待真实进程关闭，再释放串行任务", async () => {
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    mocks.spawn.mockImplementationOnce(() =>
      spawn("splayer-missing-automix-executable", [], { windowsHide: true }),
    );
    const { runAutoMixTask, runAutoMixModel } = await import("./inference");
    const signal = new AbortController().signal;
    await expect(
      runAutoMixTask(signal, () => runAutoMixModel("beat", windows, signal)),
    ).rejects.toThrow("ENOENT");
    expect(await runAutoMixTask(signal, async () => "released")).toBe("released");
  });

  it("排队期间已失效的任务不运行，后续有效任务仍可执行", async () => {
    const { runAutoMixTask } = await import("./inference");
    let release!: () => void;
    const first = runAutoMixTask(
      new AbortController().signal,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const task = vi.fn();
    const skipped = runAutoMixTask(controller.signal, task).catch((error: Error) => error);
    await flushPromises();
    controller.abort();
    release();
    await first;
    expect(await skipped).toBeInstanceOf(Error);
    expect(task).not.toHaveBeenCalled();
    expect(await runAutoMixTask(new AbortController().signal, async () => 1)).toBe(1);
  });

  it("应用退出时终止模型，排队任务不能再启动进程", async () => {
    const child = createChild();
    mocks.spawn.mockReturnValue(child);
    const { runAutoMixTask, runAutoMixModel } = await import("./inference");
    const signal = new AbortController().signal;
    const pending = runAutoMixTask(signal, () => runAutoMixModel("beat", windows, signal)).catch(
      (error: Error) => error,
    );
    await flushPromises();
    mocks.quit.mock.calls[0][1]();
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("close", null);
    expect(await pending).toBeInstanceOf(Error);
    const task = vi.fn();
    await expect(runAutoMixTask(signal, task)).rejects.toThrow();
    expect(task).not.toHaveBeenCalled();
  });
});
