import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { net } from "electron";
import { automixDir } from "@main/utils/paths";
import { broadcast } from "@main/utils/broadcast";
import { playerLog } from "@main/utils/logger";
import type {
  AutoMixComponentId,
  AutoMixComponentStatus,
  AutoMixModelStatus,
} from "@shared/types/automix";
import { AUTOMIX_COMPONENTS, AUTOMIX_RUNTIME_VERSION, AUTOMIX_WORKER } from "./assets";
import type { AutoMixAsset } from "./assets";
import { extractAutoMixPackage, readAutoMixRuntime } from "./runtime";

const models: AutoMixModelStatus[] = (["beat", "demucs", "runtime"] as const).map((id) => ({
  id,
  state: AUTOMIX_COMPONENTS[id] ? "missing" : "unsupported",
  received: 0,
  total: AUTOMIX_COMPONENTS[id]?.bytes ?? 0,
  downloadAvailable: Boolean(AUTOMIX_COMPONENTS[id]?.url),
}));
let checking: Promise<AutoMixComponentStatus> | undefined;
let installation: Promise<AutoMixComponentStatus> | undefined;
let controller: AbortController | undefined;
let checked = false;
let activeComponentId: AutoMixComponentId | undefined;

/** 汇总独立组件的紧凑状态，不包含模型或音频数据 */
const snapshot = (): AutoMixComponentStatus => ({
  state: models.every((model) => model.state === "ready")
    ? "ready"
    : models.some((model) => model.state === "downloading")
      ? "downloading"
      : models.some((model) => model.state === "error")
        ? "error"
        : "missing",
  models: models.map((item) => ({ ...item })),
});

/**
 * 分块校验下载包和解压后的模型，避免完整文件进入主进程内存
 * @param target - 待核验文件
 * @param asset - 固定版本的大小和摘要
 * @returns 文件完整且与发布清单一致时为 true
 */
const verifyAutoMixAsset = async (
  target: string,
  asset: { bytes: number; sha256: string },
): Promise<boolean> => {
  const info = await stat(target).catch(() => null);
  if (!info?.isFile() || info.size !== asset.bytes) return false;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex") === asset.sha256;
};

/**
 * 首次选择 AutoMix 时校验磁盘组件，普通查询共享结果
 * @returns 组件的安装或下载状态
 */
export const getAutoMixComponentStatus = (): Promise<AutoMixComponentStatus> => {
  if (installation || checked) return Promise.resolve(snapshot());
  if (checking) return checking;
  checking = (async () => {
    for (const model of models) {
      const asset = AUTOMIX_COMPONENTS[model.id];
      if (!asset) continue;
      const directory = path.join(automixDir, model.id);
      let ready =
        (await readFile(path.join(directory, ".version"), "utf8").catch(() => "")) ===
        (model.id === "runtime" ? AUTOMIX_RUNTIME_VERSION : asset.sha256);
      const files =
        model.id === "runtime"
          ? await readAutoMixRuntime(directory).catch(() => [])
          : asset.contents;
      if (model.id === "runtime" && !files.length) ready = false;
      for (const file of files)
        ready &&= await verifyAutoMixAsset(path.join(directory, file.file), file);
      model.state = ready ? "ready" : "missing";
      model.error = undefined;
      model.received = ready
        ? asset.bytes
        : Math.min(
            asset.bytes,
            (await stat(path.join(automixDir, asset.file + ".part")).catch(() => null))?.size ?? 0,
          );
    }
    checked = true;
    return snapshot();
  })().finally(() => {
    checking = undefined;
  });
  return checking;
};

/**
 * 从固定发布地址流式下载，校验成功后才原子替换压缩包
 * @param asset - 组件下载与完整性清单
 * @param signal - 用户取消信号
 * @param model - 当前组件的进度
 */
const downloadAsset = async (
  asset: AutoMixAsset,
  signal: AbortSignal,
  model: AutoMixModelStatus,
): Promise<void> => {
  if (!asset.url) throw new Error("组件包暂未发布，请导入本地组件包");
  const target = path.join(automixDir, asset.file);
  if (await verifyAutoMixAsset(target, asset)) return;
  signal.throwIfAborted();
  const part = target + ".part";
  const request = new AbortController();
  let deadline = setTimeout(() => request.abort(new Error("下载连接超时")), 30_000);
  try {
    let received = (await stat(part).catch(() => null))?.size ?? 0;
    if (received >= asset.bytes) {
      if (await verifyAutoMixAsset(part, asset)) {
        await rename(part, target);
        return;
      }
      await rm(part, { force: true });
      received = 0;
    }
    const response = await net.fetch(asset.url, {
      signal: AbortSignal.any([signal, request.signal]),
      headers: received ? { Range: `bytes=${received}-` } : undefined,
    });
    clearTimeout(deadline);
    deadline = setTimeout(() => request.abort(new Error("下载长时间没有进展")), 60_000);
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    if (response.status === 206) {
      const range = response.headers.get("content-range");
      if (!range || !range.startsWith(`bytes ${received}-`) || !range.endsWith(`/${asset.bytes}`)) {
        await response.body.cancel();
        throw new Error("下载续传范围不匹配");
      }
    } else received = 0;
    const file = await open(part, received ? "a" : "w");
    const startedAt = performance.now();
    const resumed = received;
    let announcedAt = 0;
    try {
      for await (const chunk of response.body) {
        clearTimeout(deadline);
        deadline = setTimeout(() => request.abort(new Error("下载长时间没有进展")), 60_000);
        received += chunk.byteLength;
        if (received > asset.bytes) throw new Error("下载文件大小不匹配");
        await file.writeFile(chunk);
        model.received = received;
        model.bytesPerSecond = Math.round(
          ((received - resumed) * 1000) / Math.max(1, performance.now() - startedAt),
        );
        if (performance.now() - announcedAt >= 200) {
          announcedAt = performance.now();
          broadcast("automix:componentStatus", snapshot(), true);
        }
      }
    } finally {
      await file.close();
    }
    if (received !== asset.bytes || !(await verifyAutoMixAsset(part, asset))) {
      await rm(part, { force: true });
      throw new Error("下载文件完整性校验失败");
    }
    await rename(part, target);
  } finally {
    clearTimeout(deadline);
    request.abort();
  }
};

/**
 * 仅在用户操作时安装独立组件，压缩包和模型均通过校验后才发布
 * @param id - 组件标识
 * @param archive - 文件选择器提供的组件包路径，省略时联网下载
 * @returns 安装完成或失败后的组件状态
 */
export const installAutoMixComponents = (
  id: AutoMixComponentId,
  archive?: string,
): Promise<AutoMixComponentStatus> => {
  if (installation)
    return activeComponentId === id
      ? installation
      : Promise.reject(new Error("请等待当前组件安装完成"));
  const model = models.find((item) => item.id === id);
  const asset = AUTOMIX_COMPONENTS[id];
  if (!model || !asset) return Promise.reject(new Error("不支持的 AutoMix 组件"));
  controller = new AbortController();
  activeComponentId = id;
  const signal = controller.signal;
  installation = (async () => {
    let wasReady = false;
    const staging = path.join(automixDir, id + ".part");
    try {
      await getAutoMixComponentStatus();
      wasReady = model.state === "ready";
      if (wasReady && !archive) return snapshot();
      model.state = "downloading";
      model.error = undefined;
      broadcast("automix:componentStatus", snapshot());
      await mkdir(automixDir, { recursive: true });
      const target = path.join(automixDir, asset.file);
      if (archive) {
        const part = target + ".import";
        try {
          await copyFile(archive, part);
          if ((id !== "runtime" || asset.sha256) && !(await verifyAutoMixAsset(part, asset)))
            throw new Error("文件校验失败，请选择当前兼容的组件包");
          signal.throwIfAborted();
          await rename(part, target);
        } finally {
          await rm(part, { force: true });
        }
      } else await downloadAsset(asset, signal, model);
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      await extractAutoMixPackage(target, staging, signal);
      const files = id === "runtime" ? await readAutoMixRuntime(staging) : asset.contents;
      for (const file of files) {
        if (!(await verifyAutoMixAsset(path.join(staging, file.file), file)))
          throw new Error("解压后的组件校验失败");
      }
      if (id === "runtime" && process.platform !== "win32")
        await chmod(path.join(staging, AUTOMIX_WORKER), 0o755);
      await writeFile(
        path.join(staging, ".version"),
        id === "runtime" ? AUTOMIX_RUNTIME_VERSION : asset.sha256,
      );
      signal.throwIfAborted();
      const destination = path.join(automixDir, id);
      wasReady = false;
      await rm(destination, { recursive: true, force: true });
      // Windows 刚解压的运行库可能短暂被占用，只重试目录发布且允许用户取消
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          await rename(staging, destination);
          break;
        } catch (error) {
          if (
            process.platform !== "win32" ||
            !["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") ||
            attempt === 5
          )
            throw error;
          await delay(250 * (attempt + 1), undefined, { signal });
        }
      }
      model.state = "ready";
      model.received = asset.bytes;
    } catch (error) {
      model.state = wasReady ? "ready" : signal.aborted ? "missing" : "error";
      model.error = signal.aborted
        ? undefined
        : error instanceof Error
          ? error.message
          : String(error);
      if (!signal.aborted) playerLog.warn("AutoMix 组件安装失败", error);
    } finally {
      try {
        await rm(staging, { recursive: true, force: true });
      } finally {
        installation = undefined;
        controller = undefined;
        activeComponentId = undefined;
        model.bytesPerSecond = undefined;
        broadcast("automix:componentStatus", snapshot());
      }
    }
    return snapshot();
  })();
  return installation;
};

/** 取消手动下载，保留可供下次续传的分块文件 */
export const cancelAutoMixDownload = (): void => controller?.abort();
