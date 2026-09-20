import { reactive, ref } from "vue";

// Shared sidebar state: which video the browser view is showing, its details,
// the fetched transcript, and the generated analysis.
export const currentVideo = ref(null); // { bvid, page } | null
export const videoDetails = ref(null);
export const transcript = ref(null);
export const analysis = ref(null);
export const progress = reactive({ visible: false, title: "", subtitle: "" });

// App-level notice card (bottom-left, rendered by App.vue) — the single
// surface for task-enqueued / finished / failed notifications from any view.
export const appNotice = ref(null); // { kind?, ok, title, file? }
let appNoticeTimer = null;
export function showAppNotice(notice, ms = 6000) {
  appNotice.value = notice;
  clearTimeout(appNoticeTimer);
  appNoticeTimer = setTimeout(() => (appNotice.value = null), ms);
}
export function dismissAppNotice() {
  clearTimeout(appNoticeTimer);
  appNotice.value = null;
}
