# Pi Web UI implementation checklist

- [x] Preserve the workspace and confirm the repository root is available.
- [x] Verify Pi, Node, npm, and Pi directory override status.
- [x] Read current and matched Pi SDK/session/security documentation.
- [x] Install `@earendil-works/pi-coding-agent@0.79.8` exactly.
- [ ] Define browser-safe protocol schemas and the Pi adapter boundary.
- [ ] Complete a fake-backed workspace/chat/SSE/resume vertical slice.
- [ ] Bind the matched SDK, native sessions, resources, models, and controls.
- [ ] Enforce loopback, CSRF/origin, workspace, session, and payload security.
- [ ] Finish responsive desktop/mobile conversation UI.
- [ ] Pass strict types, unit/integration tests, Playwright, and production build.
- [ ] Verify production health, responsive layouts, restart behavior, and docs.

Compatibility target: Pi `0.79.8`, Node engine `>=22.19.0`, native ESM.
