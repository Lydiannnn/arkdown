export const BRANDING_RUNTIME_FILES = [
  'arkdown-app-rounded.ico', 'arkdown-app-rounded-256.png',
  'arknote-app.ico', 'arknote-app-256.png',
  'ark-md.ico', 'ark-txt.ico', 'ark-docx.ico', 'ark-markdown-other.ico',
] as const
export type BrandingRuntimeFile = typeof BRANDING_RUNTIME_FILES[number]

export const OTHER_MARKDOWN_EXTENSIONS = [
  'markdown', 'mmd', 'mkd', 'mdwn', 'mdown', 'mdx',
  'mdtxt', 'mdtext', 'apib', 'rmarkdown', 'rmd', 'qmd',
] as const
