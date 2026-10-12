const PRODUCTION_CONNECT_SOURCE = "connect-src 'self' arkdown-ocr:"
const DEVELOPMENT_CONNECT_SOURCE = `${PRODUCTION_CONNECT_SOURCE} ws: http://127.0.0.1:*`

export function transformRendererCsp(html: string, command: 'build' | 'serve'): string {
  if (command === 'build') return html
  return html.replace(PRODUCTION_CONNECT_SOURCE, DEVELOPMENT_CONNECT_SOURCE)
}
