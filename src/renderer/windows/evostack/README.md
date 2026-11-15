# EvoStack renderer entry

This window mounts the existing `../main/entryPoint.tsx` and `MainApp`. It does not fork page layouts or the shared component library.

`transport.ts` installs Tauri commands and a directed Channel before importing the existing preload bridge. The Vite target substitutes `electron`, `@electron-toolkit/preload`, Electron telemetry and `WindowControls` at build time. The Electron target does not import these adapters.

The native button adapter reserves the same Windows control area and uses existing translated labels and `@cherrystudio/ui` buttons. Other page styles remain owned by the original renderer. Dragging is translated from the original drag markers to the native window command.

See [the host README](../../../../native/evostack/README.md) for supported functionality, protocol, isolated data ownership and verification. Unsupported APIs reject explicitly; a successful transport call must never stand in for an unimplemented operation.
