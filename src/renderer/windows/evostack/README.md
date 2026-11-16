# Desktop renderer entry

This entry installs the validated Tauri desktop API before mounting the existing `../main/entryPoint.tsx` and `MainApp`. The shared React pages, layout and component library remain the UI owners.

`src/platform/desktop-api` defines host-neutral contracts. `src/platform/tauri` owns command/Channel transport, projection leases, terminal backend-loss handling and event cleanup. Typed business facades validate DataApi/IpcApi DTOs. Native window controls call the same business routes directly.

Development accepts the fixed loopback Vite origin only in a debug build. Release builds accept packaged origins and keep the production CSP. Unsupported features are excluded from navigation and use the unavailable route shell. See the [host README](../../../../native/evostack/README.md) and [migration status](../../../../docs/desktop.md).
