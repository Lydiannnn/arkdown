interface ScreenshotDocumentTranslationProps {
  partial: boolean
  text: string
}

export function ScreenshotDocumentTranslation({ partial, text }: ScreenshotDocumentTranslationProps) {
  return (
    <section aria-label="文档译文" className="screenshot-document-translation" role="region">
      <div className="screenshot-document-translation__text">{text}</div>
      {partial && (
        <div className="screenshot-document-translation__partial" role="alert">
          部分内容翻译未完成，可重新翻译
        </div>
      )}
    </section>
  )
}
