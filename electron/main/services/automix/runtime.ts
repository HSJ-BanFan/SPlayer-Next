import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { open } from "yauzl";
import { z } from "zod";
import { AUTOMIX_RUNTIME_FILES, AUTOMIX_RUNTIME_VERSION } from "./assets";

const manifestSchema = z.object({
  version: z.literal(AUTOMIX_RUNTIME_VERSION),
  platform: z.literal(process.platform),
  arch: z.literal(process.arch),
  contents: z
    .array(
      z.object({
        file: z.string(),
        bytes: z
          .number()
          .int()
          .positive()
          .max(100 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .length(AUTOMIX_RUNTIME_FILES.length),
});

/**
 * 读取本机运行包清单，拒绝旧解释器、其他系统或缺失文件的构建
 * @param directory - 已解压的运行包目录
 * @returns 当前协议对应的二进制校验信息
 */
export const readAutoMixRuntime = async (directory: string) => {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")),
  );
  if (
    AUTOMIX_RUNTIME_FILES.some(
      (file) => manifest.contents.filter((item) => item.file === file).length !== 1,
    )
  )
    throw new Error("运行包文件与当前平台不匹配");
  return manifest.contents;
};

/**
 * 逐文件解压已通过摘要核验的独立环境，限制路径、文件类型和总大小
 * @param archive - 已核验的 ZIP 文件
 * @param destination - 新建的安装暂存目录
 * @param signal - 用户取消信号
 */
export const extractAutoMixPackage = async (
  archive: string,
  destination: string,
  signal: AbortSignal,
): Promise<void> => {
  const zip = await new Promise<import("yauzl").ZipFile>((resolve, reject) => {
    open(archive, { lazyEntries: true, autoClose: true }, (error, file) =>
      error || !file ? reject(error) : resolve(file),
    );
  });
  await new Promise<void>((resolve, reject) => {
    let extracted = 0;
    let reading = false;
    /**
     * 关闭文件句柄并结束安装
     * @param error - 解压失败原因
     */
    const fail = (error: unknown): void => {
      zip.close();
      reject(error);
    };
    /** 用户取消时终止 ZIP 流 */
    const abort = (): void => {
      zip.close();
      if (!reading) reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    zip.once("error", fail);
    zip.once("close", () => signal.removeEventListener("abort", abort));
    zip.once("end", resolve);
    zip.on("entry", (entry: import("yauzl").Entry) => {
      reading = true;
      void (async () => {
        signal.throwIfAborted();
        const target = path.resolve(destination, entry.fileName);
        const mode = entry.externalFileAttributes >>> 16;
        if (
          !target.startsWith(path.resolve(destination) + path.sep) ||
          (mode & 0o170000) === 0o120000 ||
          entry.fileName.includes("\\")
        )
          throw new Error("运行时压缩包含无效路径");
        extracted += entry.uncompressedSize;
        if (extracted > 600 * 1024 * 1024) throw new Error("运行时解压大小超出限制");
        if (entry.fileName.endsWith("/")) await mkdir(target, { recursive: true });
        else {
          await mkdir(path.dirname(target), { recursive: true });
          const stream = await new Promise<import("node:stream").Readable>((res, rej) => {
            zip.openReadStream(entry, (error, source) =>
              error || !source ? rej(error) : res(source),
            );
          });
          await pipeline(stream, createWriteStream(target, { flags: "wx" }), { signal });
          if (process.platform !== "win32" && mode & 0o111) await chmod(target, 0o755);
        }
        reading = false;
        signal.throwIfAborted();
        zip.readEntry();
      })().catch(fail);
    });
    if (signal.aborted) abort();
    else zip.readEntry();
  });
};
