import type { Track } from "@shared/types/player";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const heart = vi.hoisted(() => ({
  extendQueue: vi.fn(),
}));

const storage = vi.hoisted(() => ({
  getItem: vi.fn(() => Promise.resolve(null)),
  setItem: vi.fn(() => Promise.resolve()),
}));

const playerApi = vi.hoisted(() => ({
  load: vi.fn(),
  stop: vi.fn(() => Promise.resolve()),
}));

vi.mock("localforage", () => ({
  default: {
    createInstance: () => storage,
  },
}));

vi.mock("@/utils/color", () => ({ extractColorFromUrl: vi.fn() }));

vi.mock("@/services/audioSource", () => ({
  resolveTrackSource: vi.fn(async () => ({
    source: "C:/fake.mp3",
    fromCache: false,
    provider: "local",
  })),
}));

vi.mock("@/services/lyric/loader", () => ({
  beginLoad: vi.fn(),
  loadForTrack: vi.fn(),
  watchLyricPreference: vi.fn(),
}));

vi.mock("@/services/coverLoader", () => ({
  loadCoverForTrack: vi.fn(),
}));

vi.mock("@/services/abLoop", () => ({
  reset: vi.fn(),
}));

vi.mock("@/services/cacheScheduler", () => ({
  cancel: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock("@/services/nextTrackPreloader", () => ({
  consumePreloadedTrack: vi.fn(() => null),
  disposeNextTrackPreload: vi.fn(),
  installNextTrackPreloadWatchers: vi.fn(),
  scheduleNextTrackPreload: vi.fn(),
}));

vi.mock("@/composables/useFavorite", () => ({
  useFavorite: () => ({}),
}));

vi.mock("@/composables/useToast", () => ({
  toast: { info: vi.fn(), warning: vi.fn(), success: vi.fn(), loading: vi.fn() },
}));

vi.mock("@/i18n", () => ({
  default: { global: { t: (key: string) => key } },
}));

vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({
    preset: { fuckDjMode: false, uncensorProfanity: false },
    lyric: { cjkTransform: false },
  }),
}));

vi.mock("./heartMode", () => ({
  extendQueue: heart.extendQueue,
}));

import { useMediaStore } from "@/stores/media";
import * as queueStore from "@/stores/queue";
import { useStatusStore } from "@/stores/status";
import { nextTrack } from "./index";

const track = (id: string): Track => ({
  id,
  source: "netease",
  title: id,
  artists: [],
  duration: 1_000,
});

describe("nextTrack", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    queueStore.queueEntries.value = [];
    heart.extendQueue.mockReset();
    playerApi.load.mockReset();
    playerApi.load.mockResolvedValue({
      success: true,
      data: { detail: {}, mediaInfo: { duration: 1_000 } },
    });
    (window as unknown as { api: unknown }).api = { player: playerApi };
  });

  it("心动模式队列末尾按当前歌曲续推并播放新批次第一首", async () => {
    const status = useStatusStore();
    const media = useMediaStore();
    queueStore.setQueue([track("a"), track("b")]);
    status.heartMode = true;
    status.playIndex = 1;
    heart.extendQueue.mockImplementation(async () => {
      queueStore.insertManyToQueue([track("c")], queueStore.queueLength.value);
      return 1;
    });

    await nextTrack();

    expect(heart.extendQueue).toHaveBeenCalledWith("b");
    expect(queueStore.queue.value.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(status.playIndex).toBe(2);
    expect(media.track?.id).toBe("c");
  });

  it("续推没有新曲目时回退到原有的队列循环", async () => {
    const status = useStatusStore();
    queueStore.setQueue([track("a"), track("b")]);
    status.heartMode = true;
    status.playIndex = 1;
    heart.extendQueue.mockResolvedValue(0);

    await nextTrack();

    expect(status.playIndex).toBe(0);
  });

  it("续推期间队列被替换时不再回绕播放", async () => {
    const status = useStatusStore();
    const media = useMediaStore();
    queueStore.setQueue([track("a"), track("b")]);
    status.heartMode = true;
    status.playIndex = 1;
    heart.extendQueue.mockImplementation(async () => {
      queueStore.setQueue([track("x")]);
      return 0;
    });

    await nextTrack();

    expect(status.playIndex).toBe(1);
    expect(media.track).toBeNull();
  });
});
