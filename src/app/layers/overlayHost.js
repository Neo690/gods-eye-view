import {
  clearOverlaySource,
  getWorldOverlayDiagnostics,
  removeOverlayEntry,
  setOverlayEntries,
  setOverlaySourceVisible,
  upsertOverlayEntry,
} from '../../overlays/worldOverlay.js';
export const overlayHost = Object.freeze({
  clearSource: clearOverlaySource,
  getDiagnostics: getWorldOverlayDiagnostics,
  removeEntry: removeOverlayEntry,
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  upsertEntry: upsertOverlayEntry,
});
