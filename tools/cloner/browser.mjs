import { chromium } from 'playwright';

const icuFailure = (error) => /icudtl\.dat|Invalid file descriptor to ICU data/u.test(String(error));
const chromeOptions = (options) => {
  const fallback = { ...options, channel: 'chrome' };
  delete fallback.executablePath;
  return fallback;
};

async function launchWithFallback(primary, fallback, options) {
  try {
    return await primary(options);
  } catch (error) {
    if (!icuFailure(error)) throw error;
    return fallback(chromeOptions(options));
  }
}

export function launchBrowser(options = {}, runtime = chromium) {
  return launchWithFallback(
    (launchOptions) => runtime.launch(launchOptions),
    (launchOptions) => runtime.launch(launchOptions),
    options,
  );
}

export function launchPersistentContext(profile, options = {}, runtime = chromium) {
  return launchWithFallback(
    (launchOptions) => runtime.launchPersistentContext(profile, launchOptions),
    (launchOptions) => runtime.launchPersistentContext(profile, launchOptions),
    options,
  );
}
