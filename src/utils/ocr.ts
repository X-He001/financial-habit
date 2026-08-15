// =====================================================================
// OCR 助手（src/utils/ocr.ts）
// 基于 tesseract.js 的本地图片文字识别，供两处复用：
//  1. batchImport 的截图解析（已有逻辑迁移到这里）
//  2. deepseek.analyzeReceiptImage 在「纯文本模型」下的降级（先 OCR 再传文字）
// 首次使用需联网下载识别语言包（chi_sim+eng）。
// =====================================================================

export interface OcrProgress {
  label: string
  percent: number | null
}

/** 识别一张图片（data URL）中的文字，返回去空格后的文本；失败抛错 */
export async function ocrImageDataUrl(
  dataUrl: string,
  onProgress?: (label: string, percent: number | null) => void
): Promise<string> {
  const Tesseract = await import('tesseract.js')
  onProgress?.('正在加载 OCR 识别引擎（首次使用需联网下载识别模型，请耐心等待）…', 5)
  const worker = await Tesseract.createWorker('chi_sim+eng', 1, {
    logger: (m) => {
      if (!m || typeof m.progress !== 'number') return
      if (m.status === 'recognizing text') {
        onProgress?.(`OCR 识别中… ${Math.round(m.progress * 100)}%`, Math.round(m.progress * 80) + 15)
      } else {
        onProgress?.(`OCR 准备中（${m.status}）…`, 5)
      }
    },
  })
  try {
    onProgress?.('正在识别图片文字…', 15)
    const { data } = await worker.recognize(dataUrl)
    return (data.text || '').trim()
  } finally {
    await worker.terminate()
  }
}
