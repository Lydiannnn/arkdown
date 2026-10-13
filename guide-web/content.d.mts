export interface GuideSection {
  id: string
  title: string
  body: string
  summary: string
  keywords: string
}
export interface GuideChapter {
  id: string
  sourceFile: string
  markdown: string
  short: string
  icon: string
  group: string
  title: string
  intro: string
  introHtml: string
  sections: GuideSection[]
}
export const chapters: GuideChapter[]
export const version: string
export const updated: string
export function esc(value: unknown): string
