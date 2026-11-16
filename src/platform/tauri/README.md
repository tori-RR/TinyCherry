# Tauri transport

Installs the desktop API before the React application loads. Keeps correlated requests, subscription cleanup and message projections scoped to one WebView. Backend loss rejects pending requests; reconnect never replays a mutation or a model request. Development and production origins are validated separately by both the renderer and host.
