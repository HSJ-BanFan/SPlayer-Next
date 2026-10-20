import type { AutoMixComponentId } from "@shared/types/automix";
import { release } from "node:os";

/** 本项目独立导出的组件包与安装后文件的固定校验信息 */
export interface AutoMixAsset {
  file: string;
  bytes: number;
  sha256: string;
  url: string | null;
  contents: readonly { file: string; bytes: number; sha256: string }[];
}

export const AUTOMIX_RUNTIME_VERSION = "rust-1";
const [osMajor, osMinor] = release().split(".").map(Number);
const supportedMac =
  process.platform !== "darwin" ||
  (process.arch === "arm64" ? osMajor >= 23 : osMajor > 22 || (osMajor === 22 && osMinor >= 5));
export const AUTOMIX_WORKER =
  process.platform === "win32" ? "automix-worker.exe" : "automix-worker";
export const AUTOMIX_RUNTIME_FILES = [
  AUTOMIX_WORKER,
  ...(process.platform === "win32"
    ? [
        "onnxruntime.dll",
        "DirectML.dll",
        "onnxruntime_providers_shared.dll",
        "msvcp140.dll",
        "msvcp140_1.dll",
        "vcruntime140.dll",
        "vcruntime140_1.dll",
      ]
    : process.platform === "darwin"
      ? ["libonnxruntime.dylib"]
      : ["libonnxruntime.so"]),
];

export const AUTOMIX_COMPONENTS: Record<AutoMixComponentId, AutoMixAsset | null> = {
  beat: {
    file: "automix-beat-v2.zip",
    bytes: 75333389,
    sha256: "4ea821413a04501b80ac15844a5c3bf8aa2b5748f93f7c5af9c2b7c1a00917ff",
    url: null,
    contents: [
      {
        file: "beat-this.onnx",
        bytes: 82533973,
        sha256: "13ce535cb562bb68be355228fc2283e19c08140382783ec0ff693efe845b47d7",
      },
      {
        file: "beat-this.check.json",
        bytes: 5417,
        sha256: "8dba909105c654c42f2739bedf3de136335bca7813a505993e8aebe889ced535",
      },
    ],
  },
  demucs: {
    file: "automix-demucs-v2.zip",
    bytes: 98431293,
    sha256: "1e11d2022cb0bcc5b8612f5d8137cf6045fc95f9a6b18369e630118670c0577c",
    url: null,
    contents: [
      {
        file: "htdemucs.onnx",
        bytes: 176933655,
        sha256: "3a122e5fab001f0faf8e16cb5de8065948480d0310055d9d35d9239702ae1bb2",
      },
      {
        file: "htdemucs.check.json",
        bytes: 5969,
        sha256: "ae0688d9b95ee75a71b4805a2967bfb12ddc7fe986e3fea14a5b3061a00c3019",
      },
    ],
  },
  runtime:
    supportedMac &&
    ["win32", "darwin", "linux"].includes(process.platform) &&
    ["x64", "arm64"].includes(process.arch)
      ? {
          file: `automix-runtime-${process.platform}-${process.arch}.zip`,
          bytes: 0,
          // 尚未公开发布，手动导入的维护者构建包按内部清单校验
          sha256: "",
          url: null,
          contents: [],
        }
      : null,
};
