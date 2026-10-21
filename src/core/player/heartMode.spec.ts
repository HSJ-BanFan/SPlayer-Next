import type { Track } from "@shared/types/player";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchHeartModeList: vi.fn(),
}));

const user = vi.hoisted(() => ({
  likedPlaylistId: "liked-playlist" as string | null,
}));

const status = vi.hoisted(() => ({
  heartMode: true,
}));

const storage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/apis/recommend/netease", () => ({
  fetchHeartModeList: api.fetchHeartModeList,
}));

vi.mock("@/stores/user", () => ({
  useUserStore: () => user,
}));

vi.mock("@/stores/status", () => ({
  useStatusStore: () => status,
}));

vi.mock("localforage", () => ({
  default: {
    createInstance: () => storage,
  },
}));

import { queue, queueEntries, setQueue } from "@/stores/queue";
import { extendQueue } from "./heartMode";

const track = (id: string): Track => ({
  id,
  source: "netease",
  title: id,
  artists: [],
  duration: 1_000,
});

describe("heartMode", () => {
  beforeEach(() => {
    queueEntries.value = [];
    user.likedPlaylistId = "liked-playlist";
    status.heartMode = true;
    api.fetchHeartModeList.mockReset();
  });

  it("按种子续推并把未在队列中的曲目追加到末尾", async () => {
    setQueue([track("a"), track("b")]);
    api.fetchHeartModeList.mockResolvedValue([track("b"), track("c"), track("d")]);

    await expect(extendQueue("b")).resolves.toBe(2);

    expect(api.fetchHeartModeList).toHaveBeenCalledWith("b", "liked-playlist");
    expect(queue.value.map(({ id }) => id)).toEqual(["a", "b", "c", "d"]);
  });

  it("接口失败时返回 0 且不改动队列", async () => {
    setQueue([track("a")]);
    api.fetchHeartModeList.mockRejectedValue(new Error("network"));

    await expect(extendQueue("a")).resolves.toBe(0);

    expect(queue.value.map(({ id }) => id)).toEqual(["a"]);
  });

  it("没有新曲目时返回 0", async () => {
    setQueue([track("a")]);
    api.fetchHeartModeList.mockResolvedValue([track("a")]);

    await expect(extendQueue("a")).resolves.toBe(0);

    expect(queue.value.map(({ id }) => id)).toEqual(["a"]);
  });

  it("未登录或没有喜欢的歌单时不请求接口", async () => {
    setQueue([track("a")]);
    user.likedPlaylistId = null;

    await expect(extendQueue("a")).resolves.toBe(0);

    expect(api.fetchHeartModeList).not.toHaveBeenCalled();
  });

  it("请求期间退出心动模式时不追加队列", async () => {
    setQueue([track("a")]);
    api.fetchHeartModeList.mockImplementation(async () => {
      status.heartMode = false;
      return [track("b")];
    });

    await expect(extendQueue("a")).resolves.toBe(0);

    expect(queue.value.map(({ id }) => id)).toEqual(["a"]);
  });

  it("请求期间队列被替换时不追加队列", async () => {
    setQueue([track("a")]);
    api.fetchHeartModeList.mockImplementation(async () => {
      setQueue([track("x")]);
      return [track("b")];
    });

    await expect(extendQueue("a")).resolves.toBe(0);

    expect(queue.value.map(({ id }) => id)).toEqual(["x"]);
  });
});
