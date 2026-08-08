# Phase 1 Baseline

> Historical implementation snapshot: this file records Phase 1 and is not the current product contract. See [Phase 6 baseline](PHASE_6_BASELINE.md) and [project handoff](PROJECT_HANDOFF.md).

Date: 2026-08-07

## Compact desktop pet

- The main window uses an original compact SVG cat instead of displaying the inherited Live2D model.
- Visible pet content is fixed at approximately `280 × 175` physical pixels. The tested 2× Retina NSPanel uses a `280 × 176` physical-pixel transparent carrier because its window height is aligned to whole logical points; the extra row is transparent.
- Stored Live2D scale values do not affect the compact window.
- Debug builds no longer open Web Inspector automatically.
- Every keyboard press or mouse press increments a locally persisted counter.
- Left and right paws alternate on each counted input.
- Dragging, transparency, always-on-top, tray behavior and the context menu remain available.

## Quote proof of concept

- Dependency: exact `stock-api@2.7.3`.
- Provider: `stocks.tencent.getStocks(codes)`.
- The proof of concept runs only when `VITE_MARKET_POC=true` is explicitly set in development.
- One-time Tauri WebView matrix results:
  - 1 requested / 1 valid, approximately 343 ms;
  - 5 requested / 5 valid, approximately 38 ms;
  - 20 requested / 20 valid, approximately 38 ms;
  - 30 requested / 30 valid, approximately 175 ms.
- Returned records included normalized code, name, current price and percentage change.
- A deliberately rejected quote request was contained before the real matrix continued.
- The proof of concept exits after the matrix and does not start background polling.

The measurements were taken after the A-share market had closed and validate connectivity and response parsing, not intraday price movement.

## Current refresh rule

- Phase 1 itself performs no recurring quote request.
- The Phase 2 panel requests one Tencent batch when it opens and when the user presses `刷新`.
- Stock panel closed, desktop pet hidden, application sleeping or application exiting: zero quote requests.
- There is no background polling in the current desktop build.

## Validation

The following checks pass:

```bash
pnpm exec tsc --noEmit
pnpm exec eslint src
pnpm build
cargo check --locked
```

No Git repository, commit, branch, tag or remote was created.
