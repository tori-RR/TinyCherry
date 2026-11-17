---
name: vercel-react-best-practices
description: Apply selected Vercel React client performance references when TinyCherry rendering, subscriptions, data fetching or bundle cost needs investigation.
license: MIT
metadata:
  author: vercel
  version: "1.0.0"
---

# React client performance

TinyCherry uses Vite/React with a Tauri/Go backend. Use these references when they resolve an observed client cost. Preserve layout, behavior and ownership; measure before adding caching or memoization. Data mutations and native capabilities still use the typed desktop bridge.

- Independent work and deferred features: [parallel promises](rules/async-parallel.md), [conditional imports](rules/bundle-conditional.md).
- Fetching/subscriptions: [SWR deduplication](rules/client-swr-dedup.md), [event listeners](rules/client-event-listeners.md).
- State and effects: [defer reads](rules/rerender-defer-reads.md), [effect dependencies](rules/rerender-dependencies.md), [derive state without effects](rules/rerender-derived-state-no-effect.md), [functional updates](rules/rerender-functional-setstate.md), [lazy initial state](rules/rerender-lazy-state-init.md).
- Rendering: [memoization](rules/rerender-memo.md), [content visibility](rules/rendering-content-visibility.md), [static JSX](rules/rendering-hoist-jsx.md).

These selected examples come from [Vercel's agent skills](https://github.com/vercel-labs/agent-skills), originally attributed to Vercel Engineering and shuding, under the upstream MIT license. They are guidance, not a requirement to introduce another framework. Next.js, RSC, Server Actions, server caches and SSR hydration rules are outside this client's scope.
