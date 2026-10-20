import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractAutoMixPackage } from "./runtime";

const root = path.resolve("node_modules/.cache/automix-zip-test");

/**
 * 生成仅含 abc 的存储型 ZIP，检验路径及文件类型而不依赖系统压缩命令
 * @param name - ZIP 内的相对路径
 * @param mode - UNIX 文件类型与权限
 * @returns 可被正式解压器读取的 ZIP
 */
const zipFile = (name: string, mode = 0o100644): Buffer => {
  const filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(0x352441c2, 14);
  local.writeUInt32LE(3, 18);
  local.writeUInt32LE(3, 22);
  local.writeUInt16LE(filename.length, 26);
  const body = Buffer.concat([local, filename, Buffer.from("abc")]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(0x352441c2, 16);
  central.writeUInt32LE(3, 20);
  central.writeUInt32LE(3, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((mode * 65536) >>> 0, 38);
  const directory = Buffer.concat([central, filename]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
};

afterEach(async () => {
  expect(root.startsWith(path.resolve("node_modules/.cache") + path.sep)).toBe(true);
  await rm(root, { recursive: true, force: true });
});

describe("AutoMix 独立环境解压", () => {
  it("逐文件解压到指定目录", async () => {
    await mkdir(root, { recursive: true });
    const archive = path.join(root, "runtime.zip");
    await writeFile(archive, zipFile("automix-worker"));
    await extractAutoMixPackage(
      archive,
      path.join(root, "installed"),
      new AbortController().signal,
    );
    expect(await readFile(path.join(root, "installed/automix-worker"), "utf8")).toBe("abc");
  });
  it("拒绝越出安装目录的条目和符号链接", async () => {
    await mkdir(root, { recursive: true });
    for (const [name, mode] of [
      ["../escaped", 0o100644],
      ["automix-worker", 0o120777],
    ] as const) {
      const archive = path.join(root, "invalid.zip");
      await writeFile(archive, zipFile(name, mode));
      await expect(
        extractAutoMixPackage(archive, path.join(root, "installed"), new AbortController().signal),
      ).rejects.toThrow();
    }
  });
  it("取消后不生成可执行文件", async () => {
    await mkdir(root, { recursive: true });
    const archive = path.join(root, "runtime.zip");
    await writeFile(archive, zipFile("automix-worker"));
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      extractAutoMixPackage(archive, path.join(root, "installed"), controller.signal),
    ).rejects.toThrow("cancelled");
    await expect(readFile(path.join(root, "installed/automix-worker"))).rejects.toThrow();
  });
});
