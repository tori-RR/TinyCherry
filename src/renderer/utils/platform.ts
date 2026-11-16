export const platform = window.desktop?.info.platform
export const isMac = platform === 'darwin'
export const isWin = platform === 'win32'
export const isLinux = platform === 'linux'
export const isDev = window.desktop?.environment?.NODE_ENV === 'development'
export const isProd = window.desktop?.environment?.NODE_ENV === 'production'
