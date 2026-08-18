import { reactive, ref } from "vue";

// Shared sidebar state: which video the browser view is showing, its details,
// the fetched transcript, and the generated analysis.
export const currentVideo = ref(null); // { bvid, page } | null
export const videoDetails = ref(null);
export const transcript = ref(null);
export const analysis = ref(null);
export const progress = reactive({ visible: false, title: "", subtitle: "" });
