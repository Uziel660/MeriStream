import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';

export interface VisualBrowserOptions {
  headless?: boolean;
  slowMo?: number;
  recordVideo?: boolean;
  videoDir?: string;
  viewport?: { width: number; height: number };
}

const EXTENSION_PATH = path.resolve('C:/Users/Uziel/.config/opencode/visual-cursor-extension');

/**
 * Inicia un navegador con la extensión del cursor animado y soporte de grabación de sesiones.
 */
export async function launchVisualBrowser(options: VisualBrowserOptions = {}): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const {
    headless = false,
    slowMo = 50,
    recordVideo = true,
    videoDir = path.resolve(process.cwd(), 'test-recordings'),
    viewport = { width: 1280, height: 720 },
  } = options;

  const browser = await chromium.launch({
    headless,
    slowMo,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--start-maximized',
    ],
  });

  const contextOptions: any = {
    viewport,
  };

  if (recordVideo) {
    contextOptions.recordVideo = {
      dir: videoDir,
      size: viewport,
    };
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  return { browser, context, page };
}
