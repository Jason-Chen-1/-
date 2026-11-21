export async function fetchWithoutRedirect(fetchImpl, url, options) {
  const response = await fetchImpl(url, {...options, redirect: 'manual'});
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error(`上游接口返回 HTTP ${response.status} 重定向。请检查 API 地址。`);
  }
  return response;
}
