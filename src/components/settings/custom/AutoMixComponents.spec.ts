import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import type { AutoMixComponentStatus } from "@shared/types/automix";
import { autoMixComponentStatus } from "@/services/automix";
import AutoMixComponents from "./AutoMixComponents.vue";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  download: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/composables/useToast", () => ({ toast: { error: mocks.error } }));

const missing: AutoMixComponentStatus = {
  state: "missing",
  models: ["beat", "demucs", "runtime"].map((id) => ({
    id: id as "beat" | "demucs" | "runtime",
    state: "missing",
    received: 0,
    total: 100,
    downloadAvailable: true,
  })),
};
const Dialog = {
  props: ["open"],
  template: '<section v-if="open" role="dialog"><slot /></section>',
};
const Button = {
  props: ["disabled"],
  template: '<button :disabled="disabled"><slot /></button>',
};

/** 挂载真实管理逻辑，仅替换不影响异步行为的 UI 外壳 */
const mountDialog = () =>
  mount(AutoMixComponents, {
    global: {
      plugins: [
        createI18n({ legacy: false, locale: "zh-CN", missingWarn: false, fallbackWarn: false }),
      ],
      stubs: {
        SDialog: Dialog,
        SButton: Button,
        SCard: { template: "<article><slot /></article>" },
      },
    },
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("api", { automix: mocks });
  autoMixComponentStatus.value = structuredClone(missing);
});
afterEach(() => vi.unstubAllGlobals());

describe("AutoMix 模型管理", () => {
  it("未发布组件只显示禁用的下载按钮", async () => {
    const unpublished = structuredClone(missing);
    unpublished.models.forEach((model) => (model.downloadAvailable = false));
    mocks.getStatus.mockResolvedValue(unpublished);
    const wrapper = mountDialog();
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("settings.automixComponents.unpublished");
    for (const row of wrapper.findAll("article")) {
      expect(row.findAll("button")).toHaveLength(1);
      expect(row.get("button").element.disabled).toBe(true);
    }
    expect(mocks.download).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("磁盘查询尚未返回时立即显示三项配置，不强制重新校验或自动下载", async () => {
    let resolve!: (status: AutoMixComponentStatus) => void;
    mocks.getStatus.mockReturnValue(new Promise((done) => (resolve = done)));
    const wrapper = mountDialog();
    await wrapper.get("button").trigger("click");
    expect(wrapper.get('[role="dialog"]').findAll("article")).toHaveLength(3);
    expect(mocks.getStatus).toHaveBeenCalledWith();
    expect(mocks.download).not.toHaveBeenCalled();
    resolve(missing);
    await flushPromises();
    wrapper.unmount();
  });

  it("状态查询失败保留已显示的弹窗和共享状态", async () => {
    mocks.getStatus.mockRejectedValue(new Error("磁盘读取失败"));
    const wrapper = mountDialog();
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(mocks.error).toHaveBeenCalledWith("磁盘读取失败");
    expect(autoMixComponentStatus.value).toEqual(missing);
    wrapper.unmount();
  });
});
