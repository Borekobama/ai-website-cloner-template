import { chromium } from 'playwright';

const icuFailure = (error) => /icudtl\.dat|Invalid file descriptor to ICU data/u.test(String(error));
const chromeOptions = (options) => {
  const fallback = { ...options, channel: 'chrome' };
  delete fallback.executablePath;
  return fallback;
};

export async function launchBrowser(options = {}) {
  try {
    return await chromium.launch(options);
  } catch (error) {
    if (!icuFailure(error)) throw error;
    return chromium.launch(chromeOptions(options));
  }
}

export async function launchPersistentContext(profile, options = {}) {
  try {
    return await chromium.launchPersistentContext(profile, options);
  } catch (error) {
    if (!icuFailure(error)) throw error;
    return chromium.launchPersistentContext(profile, chromeOptions(options));
  }
}
