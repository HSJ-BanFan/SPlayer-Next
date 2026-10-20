<script setup lang="ts">
import type { AutoMixComponentId } from "@shared/types/automix";
import { autoMixComponentStatus, refreshAutoMixComponents } from "@/services/automix";
import { formatFileSize } from "@/utils/format";
import { toast } from "@/composables/useToast";

defineOptions({ inheritAttrs: false });
const { t } = useI18n();
const open = ref(false);
const pending = ref<{ id: AutoMixComponentId; action: "download" | "import" } | null>(null);
const status = autoMixComponentStatus;
const busy = computed(() => pending.value !== null || status.value.state === "downloading");
const models = computed(() =>
  (["beat", "demucs", "runtime"] as const).map((id) => ({
    id,
    ...status.value.models.find((item) => item.id === id),
  })),
);

/** 立即显示配置弹窗，在后台读取共享的组件状态 */
const handleOpen = (): void => {
  open.value = true;
  void refreshAutoMixComponents().catch((error: unknown) => {
    toast.error(error instanceof Error ? error.message : String(error));
  });
};

/**
 * 安装指定组件，下载和导入均校验兼容版本
 * @param id - 组件标识
 * @param action - 下载或本地文件导入
 */
const install = async (id: AutoMixComponentId, action: "download" | "import"): Promise<void> => {
  pending.value = { id, action };
  try {
    const result =
      action === "import"
        ? await window.api.automix.importFiles(id)
        : await window.api.automix.download(id);
    if (result) {
      status.value = result;
      const error = result.models.find((item) => item.id === id)?.error;
      if (error) toast.error(error);
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  } finally {
    pending.value = null;
  }
};

/** 取消安装，保留已完成文件和下载分块 */
const cancel = async (): Promise<void> => {
  try {
    await window.api.automix.cancelDownload();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
};
</script>

<template>
  <SButton variant="secondary" type="primary" size="small" @click="handleOpen">
    {{ t("settings.automixComponents.configure") }}
  </SButton>
  <SDialog v-model:open="open" :title="t('settings.automixComponents.label')" width="560px">
    <div class="flex flex-col gap-2.5">
      <p
        v-if="
          models.some((model) => model.downloadAvailable === false && model.state !== 'unsupported')
        "
        class="text-xs text-on-surface-variant/70"
      >
        {{ t("settings.automixComponents.localOnly") }}
      </p>
      <SCard v-for="model in models" :key="model.id" variant="settings">
        <div class="flex flex-wrap items-center gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-sm text-on-surface">
              {{ t(`settings.automixModels.${model.id}.label`) }}
            </div>
            <div class="mt-1 text-xs text-on-surface-variant/70 tabular-nums" aria-live="polite">
              <template v-if="model.state === 'downloading'">
                {{ formatFileSize(model.received ?? 0) }} / {{ formatFileSize(model.total ?? 0) }}
                <span v-if="model.bytesPerSecond" class="ml-2">
                  {{ formatFileSize(model.bytesPerSecond) }}/s
                </span>
              </template>
              <template v-else-if="model.state">
                {{ t(`settings.automixComponents.${model.state}`) }}
                <span v-if="model.total" class="ml-2">{{ formatFileSize(model.total) }}</span>
              </template>
              <template v-else>{{ t("common.loading") }}</template>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <SButton
              v-if="model.state === 'downloading'"
              variant="secondary"
              size="small"
              @click="cancel"
            >
              {{ t("common.cancel") }}
            </SButton>
            <SButton
              v-else
              variant="secondary"
              type="primary"
              size="small"
              :disabled="
                busy ||
                !model.downloadAvailable ||
                model.state === 'ready' ||
                model.state === 'unsupported'
              "
              :loading="pending?.id === model.id && pending.action === 'download'"
              @click="install(model.id, 'download')"
            >
              {{ t("settings.automixComponents.download") }}
            </SButton>
            <SButton
              variant="secondary"
              size="small"
              :disabled="busy || !model.state || model.state === 'unsupported'"
              :loading="pending?.id === model.id && pending.action === 'import'"
              @click="install(model.id, 'import')"
            >
              {{ t("settings.automixComponents.import") }}
            </SButton>
          </div>
        </div>
        <p v-if="model.error" role="alert" class="mt-2 break-words text-xs text-error">
          {{ model.error }}
        </p>
        <p
          v-else-if="model.state === 'missing' && model.received"
          class="mt-2 text-xs text-on-surface-variant/70"
        >
          {{ t("settings.automixComponents.incomplete") }}
        </p>
      </SCard>
    </div>
    <template #footer="{ close }">
      <SButton variant="secondary" @click="close">{{ t("common.close") }}</SButton>
    </template>
  </SDialog>
</template>
