- Retarget the Sentinel spider's walk from a **gait learned by
  [UniMate](https://github.com/Friedrich-M/UniMate)** instead of four
  hand-drawn `sin()` curves. Its text→skeletal-motion model animated the
  Unitree Go2 quadruped rig it ships in `assets/examples` (prompted "An
  object crawls slowly on eight legs"), the generated foot trajectories were
  FK-recovered from the motion features, loop-closed and baked into a small
  per-leg `[stride, lift]` table (8 phases) that now rides inline in
  `src/layers/aiAgent/spider.js` — still no sprite asset and no build step.
  Learned curves are desynchronized, so stride no longer shares one phase
  with lift: the knee bends exactly while the learned foot leaves the
  ground, and the eight drawn retarget to the learned front/rear legs with
  the middle two blending their side's pair. Headless and analytic
  behaviour is unchanged: no canvas means no body, and `spiderLegPose` is
  still a pure function a test can pin (now pinning cycle wrap and that the
  sides no longer mirror) (yourname, #1338).
