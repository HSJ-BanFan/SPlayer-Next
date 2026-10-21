/**
 * 心动模式续推
 */

import type { Track } from "@shared/types/player";
import { fetchHeartModeList } from "@/apis/recommend/netease";
import * as queue from "@/stores/queue";
import { useStatusStore } from "@/stores/status";
import { useUserStore } from "@/stores/user";

/** 续推在途 promise，并发复用 */
let fetchingPromise: Promise<Track[]> | null = null;

/**
 * 以指定歌曲为种子拉取下一批心动模式曲目
 * @param seedId - 种子歌曲 id
 * @returns 推荐曲目；接口失败或未登录时为空数组
 */
const fetchMore = (seedId: string): Promise<Track[]> => {
  if (fetchingPromise) return fetchingPromise;
  const playlistId = useUserStore().likedPlaylistId;
  if (!playlistId) return Promise.resolve([]);
  const request = fetchHeartModeList(seedId, playlistId)
    .catch((error) => {
      console.error("[heartMode] 续推失败:", error);
      return [];
    })
    .finally(() => {
      if (fetchingPromise === request) fetchingPromise = null;
    });
  fetchingPromise = request;
  return request;
};

/**
 * 按当前歌曲续推一批曲目并追加到队列末尾
 * @param seedId - 种子歌曲 id
 * @returns 实际追加的曲目数
 */
export const extendQueue = async (seedId: string): Promise<number> => {
  const status = useStatusStore();
  const entriesBefore = queue.queueEntries.value;
  const tracks = await fetchMore(seedId);
  // 请求期间退出心动模式或队列被替换/改动，放弃本批推荐
  if (!status.heartMode || queue.queueEntries.value !== entriesBefore) return 0;
  if (tracks.length === 0) return 0;
  const seen = new Set(queue.queue.value.map((track) => track.id));
  const fresh = tracks.filter((track) => !seen.has(track.id));
  if (fresh.length === 0) return 0;
  queue.insertManyToQueue(fresh, queue.queueLength.value);
  return fresh.length;
};
