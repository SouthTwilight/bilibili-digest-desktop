// Bootstrap fingerprint values, used only until the browser view's own
// player request has been captured. Keeping a fallback matters: the very
// first subtitle fetch can race the page's own first request.
export const DM_FALLBACK = Object.freeze({
  dm_img_str: "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
  dm_cover_img_str:
    "QU5HTEUgKE1pY3Jvc29mdCwgTWljcm9zb2Z0IEJhc2ljIFJlbmRlciBEcml2ZXIgKDB4MDAwMDAwOEMpIERpcmVjdDNEMTEgdnNfNV8wIHBzXzVfMCwgRDNEMTEpR29vZ2xlIEluYy4gKE1pY3Jvc29mdC",
  dm_img_inter: '{"ds":[],"wh":[6907,7244,35],"of":[22,44,22]}',
  web_location: "1315873",
});
