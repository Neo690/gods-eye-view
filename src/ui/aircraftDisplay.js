import { syncSegmentedControl } from './segmentedControl.js';

/** Own the shared aircraft display preference and its controls. */
export class AircraftDisplay {
  constructor({ elements, readDataManager, layout }) {
    Object.assign(this, elements, {
      readDataManager,
      _layoutRightPanels: layout,
    });
    // Both aircraft layers default to models enabled in proximity mode.
    this._models3dEnabled = true;
    this._models3dMode = 'proximity';
    // Density mode ships OFF: it polls a volunteer network every 5 s, so it is
    // an operator decision, never a default.
    this._densityEnabled = false;
    this._models3dModeBtns = [
      document.getElementById('models3d-mode-proximity'),
      document.getElementById('models3d-mode-all'),
    ];
  }
  get _dataManager() {
    return this.readDataManager();
  }
  _setModels3dParams(params, { origin = 'user' } = {}) {
    this._dataManager?.setLayerParams('flights', params, { origin });
    this._dataManager?.setLayerParams('military', params, { origin });
  }

  _syncModels3dFromLayerState(state) {
    const options = state?.options?.flights;
    if (!options) return;
    this._models3dEnabled = options.models3d === true;
    this._models3dMode = options.models3dMode === 'all' ? 'all' : 'proximity';
    // Density is deliberately NOT restored from stored state: it spends a
    // volunteer feed's rate limit, so it is switched on per session and never
    // re-armed by a share link or a previous session. Deriving the button from
    // that snapshot here would immediately un-light a click the operator made.
    this._syncModels3dButtonState();
    this._models3dModeRow?.classList.toggle('visible', this._models3dEnabled);
    syncSegmentedControl(this._models3dModeBtns, this._models3dMode, {
      valueOf: (button) => button.dataset.mode,
    });
    this._layoutRightPanels();
  }

  _syncModels3dModeRow() {
    if (this._models3dModeRow)
      this._models3dModeRow.classList.toggle('visible', this._models3dEnabled);
    this._layoutRightPanels();
  }

  _initModels3dToggle() {
    if (!this._models3dBtn) return;
    this._syncModels3dButtonState();
    this._syncModels3dModeRow();
  }

  _initDensityToggle() {
    if (!this._densityBtn && !document.getElementById('density-toggle')) return;
    this._syncDensityButtonState();
  }

  _setDensityEnabled(enabled) {
    this._densityEnabled = !!enabled;
    this._dataManager?.setLayerParams(
      'flights',
      { density: this._densityEnabled },
      { origin: 'user' },
    );
    this._syncDensityButtonState();
  }

  _syncDensityButtonState() {
    // Resolved at use time: the DISPLAY rail is markup that panel chrome can
    // re-render, and a node captured at construction would then be a stale one
    // that lights up nothing on screen.
    const button =
      this._densityBtn ?? document.getElementById('density-toggle');
    button?.classList.toggle('active', this._densityEnabled);
    button?.setAttribute('aria-pressed', String(this._densityEnabled));
  }

  _setModels3dEnabled(enabled) {
    this._models3dEnabled = !!enabled;
    this._setModels3dParams({ models3d: this._models3dEnabled });
    this._syncModels3dButtonState();
  }

  _setModels3dMode(mode) {
    const normalized = mode === 'all' ? 'all' : 'proximity';
    this._models3dMode = normalized;
    this._setModels3dParams({ models3dMode: normalized });
    syncSegmentedControl(this._models3dModeBtns, normalized, {
      valueOf: (button) => button.dataset.mode,
    });
    this._syncModels3dButtonState();
  }

  _syncModels3dButtonState() {
    this._models3dBtn?.classList.toggle('active', this._models3dEnabled);
    // The lit/dark state is a colour to a sighted operator and nothing at all to
    // a screen reader without this. It matters more now that the button ships
    // ACTIVE from markup (default-on, 2026-08-22): the very first thing assistive
    // tech reported was an unpressed-looking control over an armed layer.
    // Mirrors #scope-toggle, which has always carried aria-pressed.
    this._models3dBtn?.setAttribute(
      'aria-pressed',
      String(this._models3dEnabled),
    );
  }
}
