# Desktop renderer

`evostack/entryPoint.tsx` installs the validated desktop bridge, prepares preferences and locale, then mounts the retained `main/MainApp.tsx` React layout. The native HTML entry is the only desktop entry.

Keep the bootstrap separate from React components so Vite can preserve component state during HMR. Window-level subscriptions live inside providers and outside tab activities. The runtime owns locale, custom CSS, fullscreen state and topic notifications; unsupported extra windows do not start.

The HTML `logger-window-source` meta tag identifies the window. Renderer logging uses the neutral desktop transport. Platform metadata and presentation capabilities come from the validated Rust host response.

See [the native entry](evostack/README.md) and [desktop architecture](../../../docs/desktop.md).
