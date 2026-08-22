// Close-button policy for the main window.
//
// Mainstream-app behavior: the first close per launch asks whether to
// minimize to the tray or quit. Ticking "本次启动不再提醒" remembers the
// chosen action for THIS process only — every fresh launch asks again.

export const CLOSE_RESPONSE = Object.freeze({
  MINIMIZE: 0,
  QUIT: 1,
  CANCEL: 2,
});

// Maps a dialog result to the session-scoped remembered action, or null when
// nothing should be remembered (unticked checkbox / cancel).
export function rememberFromDialog(response, checkboxChecked) {
  if (!checkboxChecked) return null;
  if (response === CLOSE_RESPONSE.MINIMIZE) return "minimize";
  if (response === CLOSE_RESPONSE.QUIT) return "quit";
  return null;
}
