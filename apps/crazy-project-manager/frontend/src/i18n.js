const preference = 'crazy-pm.language';
const current = new URL(location.href).searchParams.get('lang');
let saved;
try { saved = localStorage.getItem(preference); } catch { /* A private session can still use the URL setting. */ }

const supported = value => value === 'en' || value === 'zh-CN';
export const language = supported(current) ? current : supported(saved) ? saved : 'en';
export const t = (chinese, english) => language === 'en' ? english : chinese;

document.documentElement.lang = language;
if (supported(current)) {
  try { localStorage.setItem(preference, current); } catch { /* The language also travels with page links. */ }
}

export function withLanguage(path) {
  const url = new URL(path, location.href);
  url.searchParams.set('lang', language);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function switchLanguage() {
  const url = new URL(location.href);
  url.searchParams.set('lang', language === 'en' ? 'zh-CN' : 'en');
  location.assign(url.href);
}
